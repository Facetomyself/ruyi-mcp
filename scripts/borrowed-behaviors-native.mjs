#!/usr/bin/env node
// Optional native Linux acceptance; run in an isolated container with the fixed R5 receipts.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

class CheckFailure extends Error {}
const check = (value, message) => { if (!value) throw new CheckFailure(message); };
const exec = promisify(execFile);
const jsonFile = async (file) => JSON.parse(await readFile(file, 'utf8'));
const absent = (file) => lstat(file).then(() => false, (error) => error.code === 'ENOENT');
const aborted = new AbortController();
const interrupt = () => aborted.abort();
const clients = new Set();
function safePath(key, fallback) {
  const value = process.env[key] ?? fallback;
  check(typeof value === 'string' && isAbsolute(value), `${key} must be an absolute path`);
  return value;
}

async function generationAlive(identity) {
  const { pid, startTime } = identity ?? {};
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof startTime !== 'string') return false;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return '';
    throw error;
  });
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return tail[19] === startTime && !['Z', 'X', 'x'].includes(tail[0]);
}

async function waitFor(predicate, ms, signal) {
  const deadline = performance.now() + ms;
  do {
    if (await predicate()) return true;
    await sleep(50, undefined, { signal });
  } while (performance.now() < deadline);
  return false;
}

let clicks = 0, documents = 0;
const html = `<!doctype html><meta charset="utf-8"><title>Borrowed canary</title>
<button id="canary" type="button">Borrowed canary</button><output id="clicks">0</output>
<script>
  let beat = 0, clicks = 0;
  setInterval(() => { document.title = 'Borrowed pulse ' + ++beat; }, 200);
  document.querySelector('#canary').onclick = () => {
    document.querySelector('#clicks').textContent = ++clicks;
    fetch('/canary-click', {method: 'POST', keepalive: true}).catch(() => {});
  };
</script>`;
const canary = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/canary-click') { clicks++; return res.writeHead(204).end(); }
  if (req.method !== 'GET' || req.url !== '/canary') return res.writeHead(404).end();
  documents++;
  return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
});

const result = { schema: 'ruyi-mcp-native-borrowed-behaviors.v1', passed: false };
let stage = 'inputs', work, scratch, out, identity, run, trace;
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  check(process.platform === 'linux', 'Native acceptance requires Linux');
  const cli = safePath('TRACE_CLI'), firefox = safePath('RUYI_FIREFOX_PATH');
  const receipt = safePath('TRACE_RECEIPT'), acceptance = safePath('TRACE_ACCEPTANCE');
  const root = safePath('RUYI_MCP_ROOT', fileURLToPath(new URL('..', import.meta.url)));
  const entry = safePath('RUYI_MCP_ENTRY', join(root, 'build/src/index.js'));
  const localRequire = createRequire(join(root, 'package.json'));
  const sdk = (name) => import(pathToFileURL(localRequire.resolve(`@modelcontextprotocol/sdk/client/${name}.js`)).href);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('index'), sdk('stdio')]);
  trace = async (command, args = []) => {
    let payload;
    try {
      const { stdout } = await exec(process.execPath, [cli, command, '--json', ...args], {
        timeout: command === 'start' ? 90_000 : command === 'stop' ? 60_000 : 12_000, maxBuffer: 1024 * 1024,
      });
      payload = JSON.parse(stdout);
    } catch (error) {
      const suffix = Number.isInteger(error.code) ? ` (exit ${error.code})` : '';
      throw new CheckFailure(`Trace ${command} failed${suffix}`);
    }
    check(payload && payload.ok !== false, `Trace ${command} reported failure`);
    return payload;
  };
  const connect = async () => {
    const client = new Client({ name: 'native-borrowed-behaviors', version: '1.0.0' });
    clients.add(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root,
      stderr: 'ignore', env: { RUYI_MCP_TOOLSET: 'all' } }), { timeout: 10_000, signal: aborted.signal });
    check(client.getServerVersion()?.name === 'ruyi-mcp', 'Unexpected MCP server identity');
    return client;
  };
  const call = async (client, name, args = {}, { error, wrapped } = {}) => {
    const request = wrapped ? { name: 'ruyi_execute_tool', arguments: { name, arguments: args } } : { name, arguments: args };
    const reply = await client.callTool(request, undefined, { timeout: 15_000, signal: aborted.signal });
    const text = reply.content?.find((part) => part.type === 'text')?.text;
    if (error) { check(reply.isError === true && typeof text === 'string' && error.test(text), `${name} returned the wrong tool error`); return; }
    check(reply.isError !== true && typeof text === 'string', `${name} lacked success data`);
    return JSON.parse(text);
  };

  stage = 'start';
  aborted.signal.throwIfAborted();
  work = await realpath(tmpdir());
  scratch = await mkdtemp(join(work, 'ruyi-native-borrowed-'));
  out = join(scratch, 'run');
  canary.listen(0, '127.0.0.1');
  await once(canary, 'listening');
  const origin = `http://127.0.0.1:${canary.address().port}`;
  run = await trace('start', ['--mcp', '--gated', '--gate', 'auto', '--firefox', firefox, '--out', out,
    '--origin', origin, '--receipt', receipt, '--acceptance', acceptance, '--', `${origin}/canary`]);
  check(run.ok === true && run.running === true && run.out === out && run.origin === origin && run.gate?.confirmation === 'session-started' &&
    typeof run.runId === 'string' && typeof run.contextId === 'string' && run.contextId.length > 0 &&
    run.descriptorPath === join(out, 'control', 'session.json'), 'Trace start lacked the original run and native gate acknowledgement');
  const state = () => jsonFile(join(out, 'state.json'));
  identity = await state();
  const requireSameGeneration = async () => {
    const [live, current] = await Promise.all([trace('status', ['--run', out]), state()]);
    check(live.running === true && live.phase === 'running' && current.runId === run.runId && live.runId === run.runId &&
      live.pid === run.pid && identity.browser?.pid === run.pid && live.contextId === run.contextId && live.descriptorPath === run.descriptorPath &&
      isDeepStrictEqual(current.owner, identity.owner) && isDeepStrictEqual(current.browser, identity.browser) &&
      await generationAlive(identity.owner) && await generationAlive(identity.browser), 'Trace owner or browser generation changed');
  };
  await requireSameGeneration();
  const scoped = { pageIdx: 0, frameContextId: run.contextId };
  const checkStatus = (s, active) => check(s?.alive === true && s?.sessionMode === 'borrowed' && s?.runId === run.runId &&
    s?.contextId === run.contextId && s?.leaseState === (active ? 'active' : 'revoked') && s?.controlAvailable === active,
  'MCP status did not match the original run and expected lease state');
  const attach = async (client) => checkStatus(await call(client, 'ruyi_attach_trace_session', { sessionPath: run.descriptorPath }), true);
  const quit = async (client, effect) => {
    const reply = await call(client, 'ruyi_browser_quit');
    check(reply.quit === true && reply.effect === effect && reply.owner === 'ruyitrace' &&
      reply.browserDisposition === 'retained_by_owner', 'Borrowed quit did not report the expected lease disposition');
    await client.close();
    clients.delete(client);
  };
  const snapshot = (client) => call(client, 'ruyi_observe', scoped);
  const click = (snap) => {
    const index = snap.nodes?.find((node) => node.role === 'button' && node.name === 'Borrowed canary' && node.visible === true)?.index;
    check(Number.isSafeInteger(index) && typeof snap.snapshotId === 'string', 'Borrowed snapshot omitted the visible canary');
    return { ...scoped, op: 'CLICK', snapshotId: snap.snapshotId, index };
  };

  stage = 'scope-and-release';
  const first = await connect();
  await attach(first);
  checkStatus(await call(first, 'ruyi_browser_status'), true);
  const firstSnapshot = await snapshot(first), clickArgs = click(firstSnapshot);
  let wrongScopeRejected = 0;
  for (const wrapped of [false, true]) {
    for (const wrong of [{ ...scoped, pageIdx: 1 }, { ...scoped, frameContextId: `${run.contextId}-wrong` }]) {
      const opts = { error: /\bUNSUPPORTED_SCOPE\b/, wrapped };
      await call(first, 'ruyi_observe', wrong, opts);
      await call(first, 'ruyi_act', { ...clickArgs, ...wrong }, opts);
      wrongScopeRejected += 2;
    }
  }
  const sentinel = await call(first, 'ruyi_trace_control', { action: 'query', selector: '#clicks', maxElements: 1 });
  check(sentinel.elements?.[0]?.text === '0' && clicks === 0 && documents > 0, 'Wrong scope mutated the real canary');
  result.wrongScopeRejected = wrongScopeRejected;
  result.canaryClicks = { beforeLegitimate: clicks };
  await call(first, 'ruyi_act', clickArgs);
  check(await waitFor(() => clicks === 1, 5000, aborted.signal), 'Correctly scoped click did not reach the live canary');
  result.canaryClicks.afterLegitimate = clicks;
  await quit(first, 'lease_released');
  await requireSameGeneration();
  result.browserRetained = true;

  stage = 'reacquire-and-expire';
  const second = await connect();
  await attach(second);
  const leaseClock = performance.now();
  const nextSnapshot = await snapshot(second);
  check(nextSnapshot.snapshotId !== firstSnapshot.snapshotId, 'The second borrower reused the first snapshot');
  const nextClick = click(nextSnapshot);
  await sleep(Math.max(0, 121_000 - (performance.now() - leaseClock)), undefined, { signal: aborted.signal });
  checkStatus(await call(second, 'ruyi_browser_status'), false);
  const revoked = { error: /\bLEASE_(?:INVALID|EXPIRED|REVOKED)\b/ };
  result.canaryClicks.beforeExpired = clicks;
  await call(second, 'ruyi_act', nextClick, revoked);
  await call(second, 'ruyi_trace_control', { action: 'click', selector: '#canary' }, revoked);
  await quit(second, 'lease_already_lost');
  await requireSameGeneration();
  check(clicks === 1, 'Expired borrower mutated the real canary');
  result.canaryClicks.afterExpired = clicks;
  result.expiryVerified = true;

  stage = 'native-stop';
  const stopped = await trace('stop', ['--run', out]);
  const persisted = await jsonFile(join(out, 'result.json'));
  check(stopped.ok === true && stopped.stopped === true && stopped.runId === run.runId &&
    persisted.runId === run.runId && persisted.passed === true && persisted.exit === 0 && persisted.completion === 'requested-stop' &&
    isDeepStrictEqual(stopped.result, persisted), 'Trace stop did not confirm the original run');
  check(persisted.gate?.observed === 'closed' && persisted.gate?.confirmation === 'session-stopped' &&
    persisted.gate?.writers?.length > 0 && persisted.files?.core?.rows > 0, 'Trace stop lacked native gate and trace evidence');
  const { leasesAcquired, leasesReleased, leasesExpired, leasesRevoked, debuggerPauseNotices, drainVerified, bidi } = persisted.mcp ?? {};
  check(leasesAcquired === 2 && leasesReleased === 1 && leasesExpired === 1 && leasesRevoked === 0 && debuggerPauseNotices === 0 &&
    drainVerified === true && bidi?.sessionNew === 1 && bidi?.sessionEnd === 1 && bidi?.sessionEndAcknowledged === true,
  'Trace stop reported unexpected lease or owner cleanup counters');
  check(clicks === 1 && await absent(run.descriptorPath) && await absent(join(identity.profile, 'trace.on')) &&
    await waitFor(async () => !(await generationAlive(identity.browser)) && !(await generationAlive(identity.owner)), 5000),
  'Trace cleanup left the browser, owner, gate, descriptor, or an unexpected canary click');
  result.nativeCleanup = { leasesAcquired, leasesReleased, leasesExpired, leasesRevoked, debuggerPauseNotices, drainVerified,
    sessionNew: bidi.sessionNew, sessionEnd: bidi.sessionEnd, sessionEndAcknowledged: bidi.sessionEndAcknowledged };
  result.passed = true;
} catch (error) {
  result.failure = { stage, reason: aborted.signal.aborted ? 'Interrupted' : error instanceof CheckFailure ? error.message : 'Unexpected local error' };
} finally {
  const closed = await Promise.allSettled([...clients].map((client) => client.close()));
  const clean = await (async () => {
    if (!scratch) return true;
    const current = identity ?? await jsonFile(join(out, 'state.json')).catch(() => null);
    const exited = async () => !(await generationAlive(current?.owner)) && !(await generationAlive(current?.browser));
    if (!await exited()) await trace('stop', ['--run', out]).catch(() => {});
    if (!await waitFor(exited, 5000) || dirname(scratch) !== work || await realpath(scratch) !== scratch) return false;
    await rm(scratch, { recursive: true, force: true });
    return true;
  })().catch(() => false);
  const canaryClosed = !canary.listening || await new Promise((resolve) => {
    canary.close((error) => resolve(!error));
    canary.closeAllConnections();
  });
  if (!clean || !canaryClosed || closed.some((item) => item.status === 'rejected')) {
    result.passed = false;
    result.failure ??= { stage: 'cleanup', reason: 'Local cleanup did not complete' };
  }
  if (aborted.signal.aborted) {
    result.passed = false;
    result.failure ??= { stage, reason: 'Interrupted' };
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = aborted.signal.aborted ? 130 : 1;
}
