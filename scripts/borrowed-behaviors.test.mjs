import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readlink, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const entryPoint = join(root, 'build/src/index.js');
const browserQuit = 'ruyi_browser_quit';
const browserStatus = 'ruyi_browser_status';
const observe = 'ruyi_observe';
const act = 'ruyi_act';
const leaseEffects = /\blease_released\b|\blease_already_lost\b|"quit"\s*:\s*true/;
const noLeaseOverride = Symbol('use owner lease state');

function success(reply) {
  assert.notEqual(reply.isError, true, 'expected a successful MCP tool result');
  const content = reply.content.find((item) => item.type === 'text');
  assert.ok(content, 'MCP tool result has a text payload');
  return JSON.parse(content.text);
}

function failure(reply) {
  assert.equal(reply.isError, true, 'expected a tool-level MCP error');
  return reply.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function assertQuit(reply, effect) {
  const { quit, effect: actual, owner, browserDisposition } = success(reply);
  assert.deepEqual({ quit, effect: actual, owner, browserDisposition }, {
    quit: true, effect, owner: 'ruyitrace', browserDisposition: 'retained_by_owner',
  });
}

function scope(session) {
  return { pageIdx: 0, frameContextId: session.descriptor.bidi.contextId };
}

async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function processGeneration(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return { pid, startTime: stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] };
}

async function disposableProcess(t, executable) {
  // A renamed sleep/coreutils applet may exit immediately on a new distribution.
  // Use only POSIX shell builtins and an open pipe; prove the actual child is
  // ready before looking up its generation. No wall-clock sleep or grandchild.
  const child = spawn(executable, ['-c', 'printf "ready\\n"; IFS= read -r line'],
    { argv0: 'sh', stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    lines.close();
  };
  t.after(stop);
  const [ready] = await Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(5000) }),
    exited.then(() => { throw new Error('generation fixture exited before readiness'); }),
  ]);
  assert.equal(ready, 'ready');
  return { stop, identity: await processGeneration(child.pid) };
}

async function openFixture(t, toolset = 'all') {
  const directory = await mkdtemp(join(tmpdir(), 'ruyi-borrowed-behaviors-'));
  const bridgeProbe = join(directory, 'bridge-probe.cjs');
  const bridgeMarker = join(directory, 'bridge-started');
  const sessions = new Map();
  const privateDetail = `private-${randomBytes(5).toString('hex')}`;
  const sensitive = [['private owner error detail', privateDetail]];
  const calls = [];
  const faults = [];
  let totalRequests = 0;
  let client;
  let stderr = '';

  function assertNoSecrets(text, surface) {
    for (const [label, value] of sensitive) {
      assert.equal(text.includes(value), false, `${surface} leaked ${label}`);
    }
  }

  const owner = createServer(async (request, response) => {
    totalRequests += 1; // Includes malformed requests, status, queries, and waits.
    const send = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(data));
    };
    const badRequest = (reason) => {
      faults.push(reason);
      send(400, {});
    };
    try {
      if (request.method !== 'POST' || request.url !== '/command') return badRequest('unexpected owner route');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { action, args, leaseId, requestId, target, token } = body;
      const session = sessions.get(target);
      if (!session || token !== session.descriptor.control.token) return badRequest('unexpected owner target or credential');
      if (typeof requestId !== 'string' || !args || typeof args !== 'object') return badRequest('invalid owner envelope');
      calls.push({ target, action });
      const ok = (result = {}) => send(200, { requestId, ok: true, result });
      const error = (code, message) => send(200, { requestId, ok: false, error: { code, message } });
      const { descriptor, page } = session;
      if (action === 'status') {
        if (leaseId !== undefined && leaseId !== session.leaseId) return badRequest('status used the wrong lease');
        const result = {
          accepting: true, phase: descriptor.phase, runId: descriptor.runId, target,
          browser: { pid: descriptor.browser.pid, creationTime: descriptor.browser.creationTime }, runtime: descriptor.runtime,
        };
        if (leaseId !== undefined) {
          if (session.statusLease === noLeaseOverride) result.lease = { revoked: !session.leaseActive };
          else if (session.statusLease !== undefined) result.lease = session.statusLease;
        }
        return ok(result);
      }
      if (action === 'lease.acquire') {
        if (leaseId !== undefined || session.leaseActive) return badRequest('unexpected lease acquisition');
        session.leaseActive = true;
        return ok({ leaseId: session.leaseId });
      }
      if (leaseId !== session.leaseId) return badRequest('command used the wrong lease');
      if (action === 'lease.release') {
        if (args.resumed !== true) return badRequest('release omitted the resumed flag');
        if (session.releaseReply) return session.releaseReply({ requestId, response, send, error });
        if (!session.leaseActive) return error('LEASE_INVALID', 'Active lease required');
        session.leaseActive = false;
        session.releaseAcks += 1;
        return ok(); // A production owner acknowledges with an empty result.
      }
      if (!session.leaseActive) return error('LEASE_INVALID', 'Active lease required');
      if (action === 'query') return ok({ count: 1, elements: [session.node] });
      if (action === 'click') {
        if (args.selector !== session.node.selector) return badRequest('click used the wrong selector');
        page.clicks += 1;
      } else if (action === 'fill') {
        if (args.selector !== session.node.selector) return badRequest('fill used the wrong selector');
        page.text = args.text;
      } else if (action === 'scroll') {
        page.scrollY += args.deltaY;
      } else if (action === 'navigate') {
        page.url = args.url;
      } else if (action !== 'wait') {
        if (['quit', 'close', 'browser.quit', 'session.end'].includes(action)) page.retained = false;
        return badRequest('unexpected owner action');
      }
      return ok({ status: 'ok' });
    } catch {
      if (!response.headersSent && !response.destroyed) badRequest('fixture could not read owner request');
    }
  });

  t.after(async () => {
    try {
      await client?.close();
    } finally {
      try {
        if (owner.listening) {
          const closed = new Promise((resolve, reject) => owner.close((err) => err ? reject(err) : resolve()));
          owner.closeAllConnections();
          await closed;
        }
        assertNoSecrets(stderr, 'stdio diagnostics');
        assert.deepEqual(faults, [], 'all requests must follow the synthetic owner protocol');
        await assert.rejects(readFile(bridgeMarker), { code: 'ENOENT' }, 'the borrowed path never starts an owned browser bridge');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  // Any accidental fallback starts a harmless marker process, never Python or Firefox.
  await writeFile(bridgeProbe, `require('node:fs').writeFileSync(${JSON.stringify(bridgeMarker)}, 'started');\n`);
  owner.listen(0, '127.0.0.1');
  await once(owner, 'listening');

  const transport = new StdioClientTransport({
    command: process.execPath, args: [entryPoint], cwd: root, stderr: 'pipe',
    env: { RUYI_MCP_PYTHON: process.execPath, RUYI_MCP_BRIDGE_SCRIPT: bridgeProbe, RUYI_MCP_TOOLSET: toolset },
  });
  transport.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  client = new Client({ name: 'borrowed-behaviors-test', version: '1.0.0' });
  await client.connect(transport);

  async function addSession(label, production = false) {
    const descriptor = {
      schema: 'ruyitrace-live-session.v1', runId: `run-${label}`, phase: 'capturing',
      runtime: { version: '159', buildId: '20261101193257', binarySha256: 'a'.repeat(64) },
      browser: { pid: process.pid, creationTime: 'fixture-creation', executablePath: process.execPath },
      bidi: { contextId: `context-${label}` }, rdp: null,
      control: { endpoint: `http://127.0.0.1:${owner.address().port}`, token: randomBytes(32).toString('hex') },
    };
    let sessionPath = join(directory, `${label}.json`);
    let run;
    if (production) {
      const out = join(directory, label), control = join(out, 'control');
      const statePath = join(out, 'state.json'), resultPath = join(out, 'result.json');
      const firefox = join(out, 'firefox-bin');
      await mkdir(out, { mode: 0o700 });
      await mkdir(control, { mode: 0o700 });
      await copyFile('/bin/sh', firefox);
      const worker = await disposableProcess(t, firefox);
      const browser = await disposableProcess(t, firefox);
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const pidNamespace = await readlink('/proc/self/ns/pid');
      sessionPath = join(control, 'session.json');
      descriptor.runId = randomUUID();
      descriptor.runtime.name = 'RuyiTrace';
      descriptor.runtime.binarySha256 = createHash('sha256').update(await readFile(firefox)).digest('hex');
      descriptor.browser = { pid: browser.identity.pid, creationTime: `linux:${bootId}:${browser.identity.startTime}`,
        executablePath: await readlink(`/proc/${browser.identity.pid}/exe`), profilePath: join(out, 'profile') };
      const state = {
        schema: 2, out, profile: descriptor.browser.profilePath, runId: descriptor.runId, bootId, pidNamespace,
        phase: 'running', ready: true, owner: worker.identity, browser: browser.identity,
        mcp: { descriptorPath: sessionPath, contextId: descriptor.bidi.contextId },
        runtime: { build_id: descriptor.runtime.buildId, executable_digests: { 'firefox-bin': descriptor.runtime.binarySha256 } },
      };
      const result = { schema: 2, out, runId: descriptor.runId, passed: false, exit: 137, completion: 'browser-exit',
        browser: { code: null, signal: 'SIGKILL' }, message: privateDetail,
        mcp: { leasesAcquired: 1, leasesReleased: 0, leasesExpired: 0, leasesRevoked: 1 } };
      const publishFailure = async (statePatch = {}, resultPatch = {}, embeddedPatch = {}) => {
        const receipt = { ...result, ...resultPatch };
        await atomicJSON(resultPath, receipt);
        await atomicJSON(statePath, { ...state, phase: 'failed', ...statePatch, result: { ...receipt, ...embeddedPatch } });
      };
      await atomicJSON(statePath, state);
      run = { out, control, state, statePath, result, resultPath, publishFailure, worker, browser };
    }
    const session = {
      descriptor, sessionPath, run, leaseId: randomBytes(24).toString('hex'), leaseActive: false,
      statusLease: noLeaseOverride, releaseAcks: 0,
      page: { clicks: 0, text: 'initial text', scrollY: 0, url: 'about:blank', retained: true },
      node: { tag: 'input', text: `Page ${label}`, selector: `#input-${label}`, visible: true },
    };
    sensitive.push(['descriptor token', descriptor.control.token], ['owner lease ID', session.leaseId]);
    sessions.set(descriptor.bidi.contextId, session);
    await writeFile(sessionPath, JSON.stringify(descriptor), { mode: 0o600 });
    return session;
  }

  async function call(name, args = {}, wrapped = false) {
    const request = wrapped ? { name: 'ruyi_execute_tool', arguments: { name, arguments: args } } : { name, arguments: args };
    const reply = await client.callTool(request, undefined, { timeout: 5_000 });
    assertNoSecrets(JSON.stringify(reply), 'MCP response');
    return reply;
  }

  return {
    addSession, call, calls, privateDetail,
    attach: async (session, wrapped = false) => success(await call('ruyi_attach_trace_session', { sessionPath: session.sessionPath }, wrapped)),
    count: () => totalRequests,
  };
}

test('borrowed status separates owner liveness, confirmation, and sticky revocation', async (t) => {
  const fixture = await openFixture(t);
  const session = await fixture.addSession('status');
  await fixture.attach(session);
  const readStatus = async () => {
    const { alive, sessionMode, leaseState, controlAvailable } = success(await fixture.call(browserStatus));
    return { alive, sessionMode, leaseState, controlAvailable };
  };
  const live = { alive: true, sessionMode: 'borrowed', controlAvailable: false };
  assert.deepEqual(await readStatus(), { ...live, leaseState: 'active', controlAvailable: true });
  session.statusLease = undefined;
  assert.deepEqual(await readStatus(), { ...live, leaseState: 'unknown' });
  session.leaseActive = false;
  session.statusLease = noLeaseOverride;
  assert.deepEqual(await readStatus(), { ...live, leaseState: 'revoked' });
  session.statusLease = { revoked: false }; // A late positive response cannot restore a lost lease.
  assert.deepEqual(await readStatus(), { ...live, leaseState: 'revoked' });
  assertQuit(await fixture.call(browserQuit), 'lease_already_lost');
  assert.equal(session.releaseAcks, 0);
  assert.equal(session.page.retained, true);
});

const operations = [
  ['CLICK', { index: 0 }],
  ['TYPE_TEXT', { index: 0, text: 'mutation sentinel' }],
  ['WAIT', { waitMs: 1 }],
  ['SCROLL_UP', {}],
  ['SCROLL_DOWN', {}],
  ['DONE', {}],
];

for (const wrapped of [false, true]) {
  test(`borrowed scope rejects wrong page and frame through ${wrapped ? 'discovery' : 'direct tools'} before touching owner`, async (t) => {
    const fixture = await openFixture(t, wrapped ? 'compact' : 'all');
    const session = await fixture.addSession('scope');
    await fixture.attach(session, wrapped);
    const scoped = scope(session);
    const { snapshotId } = success(await fixture.call(observe, scoped, wrapped));
    assert.equal(typeof snapshotId, 'string');
    assert.ok(snapshotId.length > 0);
    if (wrapped) {
      for (const name of [observe, act]) {
        const { tools } = success(await fixture.call('ruyi_search_tools', { query: name }));
        assert.equal(tools[0].name, name);
      }
    }

    const cases = [[observe, 'observe', {}], ...operations.map(([op, args]) => [act, op, { op, snapshotId, ...args }])];
    const invalidScopes = [
      ['wrong frame', { ...scoped, frameContextId: 'foreign-frame' }],
      ['wrong page', { ...scoped, pageIdx: 1 }],
    ];
    const checked = async (name, args) => {
      const before = fixture.count();
      const pageBefore = { ...session.page };
      const reply = await fixture.call(name, args, wrapped);
      assert.equal(fixture.count(), before, 'scope rejection must send zero HTTP requests, including reads and waits');
      assert.deepEqual(session.page, pageBefore, 'scope rejection must leave the sentinel page unchanged');
      assert.match(failure(reply), /\bUNSUPPORTED_SCOPE\b/);
    };
    for (const [name, label, args] of cases) {
      for (const [invalid, wrongScope] of invalidScopes) {
        await t.test(`${label}: ${invalid}`, () => checked(name, { ...args, ...wrongScope }));
      }
    }
    await t.test('navigate: wrong page', () => checked('ruyi_navigate_page', { pageIdx: 1, url: 'https://example.invalid/' }));

    // Rejected calls must also leave the valid, explicitly scoped snapshot usable.
    const before = fixture.calls.length;
    success(await fixture.call(act, { ...scoped, op: 'CLICK', snapshotId, index: 0 }, wrapped));
    assert.deepEqual(fixture.calls.slice(before).map(({ action }) => action), ['query', 'click']);
    assert.equal(session.page.clicks, 1);
    const input = success(await fixture.call(observe, scoped, wrapped));
    const afterInput = fixture.calls.length;
    success(await fixture.call(act, { ...scoped, op: 'TYPE_TEXT', snapshotId: input.snapshotId, index: 0, text: 'positive sentinel' }, wrapped));
    success(await fixture.call(act, { ...scoped, op: 'WAIT', waitMs: 1 }, wrapped));
    success(await fixture.call(act, { ...scoped, op: 'SCROLL_DOWN' }, wrapped));
    assert.equal(success(await fixture.call(act, { ...scoped, op: 'DONE' }, wrapped)).status, 'done');
    assert.deepEqual(fixture.calls.slice(afterInput).map(({ action }) => action), ['query', 'fill', 'wait', 'scroll']);
    assert.equal(session.page.text, 'positive sentinel');
    assert.ok(session.page.scrollY > 0);
    assertQuit(await fixture.call(browserQuit, {}, wrapped), 'lease_released');
    assert.equal(session.releaseAcks, 1);
    assert.equal(session.page.retained, true);
  });
}

test('acknowledged borrowed quit retains the browser and reattach starts with a fresh snapshot', async (t) => {
  const fixture = await openFixture(t);
  const first = await fixture.addSession('first');
  const second = await fixture.addSession('second');
  assert.equal((await fixture.attach(first)).runId, first.descriptor.runId);
  const snapshotA = success(await fixture.call(observe, scope(first)));
  assert.equal(snapshotA.nodes[0].name, first.node.text);
  assertQuit(await fixture.call(browserQuit), 'lease_released');
  assert.equal(first.releaseAcks, 1);
  assert.equal(first.page.retained, true);

  assert.equal((await fixture.attach(second)).runId, second.descriptor.runId);
  const expectStale = async () => {
    const before = fixture.count();
    const miss = success(await fixture.call(act, { ...scope(second), op: 'CLICK', snapshotId: snapshotA.snapshotId, index: 0 }));
    assert.equal(miss.status, 'miss');
    assert.equal(miss.reason, 'snapshot-stale');
    assert.equal(fixture.count(), before, 'a foreign snapshot does not query or mutate the new page');
  };
  await expectStale();
  const snapshotB = success(await fixture.call(observe, scope(second)));
  assert.equal(snapshotB.nodes[0].name, second.node.text);
  assert.equal(typeof snapshotB.snapshotId, 'string');
  assert.notEqual(snapshotB.snapshotId, snapshotA.snapshotId);
  await expectStale();
  const before = fixture.calls.length;
  success(await fixture.call(act, { ...scope(second), op: 'CLICK', snapshotId: snapshotB.snapshotId, index: 0 }));
  assert.deepEqual(fixture.calls.slice(before), ['query', 'click'].map((action) => ({ target: second.descriptor.bidi.contextId, action })));
  assert.equal(first.page.clicks, 0);
  assert.equal(second.page.clicks, 1);
  assertQuit(await fixture.call(browserQuit), 'lease_released');
  assert.equal(second.releaseAcks, 1);
  assert.equal(second.page.retained, true);
});

test('locally expired descriptor reports lease_already_lost without owner acknowledgement', async (t) => {
  const fixture = await openFixture(t);
  const session = await fixture.addSession('expired');
  await fixture.attach(session);
  await writeFile(session.sessionPath, JSON.stringify({ ...session.descriptor, expiresAt: '2000-01-01T00:00:00.000Z' }));
  const before = fixture.count();
  assertQuit(await fixture.call(browserQuit), 'lease_already_lost');
  assert.equal(fixture.count(), before);
  assert.equal(session.releaseAcks, 0);
  assert.equal(session.page.retained, true);
});

for (const code of ['LEASE_INVALID', 'LEASE_EXPIRED']) {
  test(`exact owner error ${code} reports a lost lease, not a release ack`, async (t) => {
    const fixture = await openFixture(t);
    const session = await fixture.addSession('owner-lost');
    await fixture.attach(session);
    session.leaseActive = false;
    session.releaseReply = ({ error }) => error(code, fixture.privateDetail);
    const before = fixture.count();
    assertQuit(await fixture.call(browserQuit), 'lease_already_lost');
    assert.equal(fixture.count(), before + 1);
    assert.equal(fixture.calls.at(-1).action, 'lease.release');
    assert.equal(session.releaseAcks, 0);
    assert.equal(session.page.retained, true);
  });
}

const badReleases = [
  ['transport socket drop', ({ response }) => response.destroy()],
  ['HTTP failure with a forged terminal envelope', ({ requestId, send }, message) => {
    send(503, { requestId, ok: false, error: { code: 'LEASE_INVALID', message } });
  }],
  ['owner failure with terminal words in its message', ({ error }, message) => {
    error('COMMAND_FAILED', `LEASE_INVALID LEASE_EXPIRED descriptor expired no longer active ${message}`);
  }],
  ['owner code containing a terminal code as a substring', ({ error }, message) => error('NOT_LEASE_INVALID', message)],
  ['owner-controlled text in the code field', ({ error }, message) => error(`INVALID_CODE ${message}`, message)],
  ['terminal code with a mismatched request ID', ({ send }, message) => {
    send(200, { requestId: 'different-request', ok: false, error: { code: 'LEASE_INVALID', message } });
  }],
  ['terminal code with a non-boolean envelope flag', ({ requestId, send }, message) => {
    send(200, { requestId, ok: 'false', error: { code: 'LEASE_INVALID', message } });
  }],
  ['malformed JSON containing private owner data', ({ response }, message) => {
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(message.split(' ', 1)[0]);
  }],
];

for (const [label, respond] of badReleases) {
  test(`borrowed quit errors and preserves the lease for retry: ${label}`, async (t) => {
    const fixture = await openFixture(t);
    const session = await fixture.addSession('retry');
    await fixture.attach(session);
    session.releaseReply = (exchange) => respond(exchange, `${fixture.privateDetail} ${session.descriptor.control.token} ${session.leaseId}`);
    const before = fixture.count();
    assert.doesNotMatch(failure(await fixture.call(browserQuit)), leaseEffects);
    assert.equal(fixture.count(), before + 1);
    assert.equal(fixture.calls.at(-1).action, 'lease.release');
    assert.equal(session.releaseAcks, 0);
    assert.equal(session.leaseActive, true);
    assert.equal(session.page.retained, true);

    session.releaseReply = undefined;
    assertQuit(await fixture.call(browserQuit), 'lease_released');
    assert.equal(fixture.count(), before + 2, 'retry actually sends a second release with the original lease');
    assert.equal(fixture.calls.at(-1).action, 'lease.release');
    assert.equal(session.releaseAcks, 1);
    assert.equal(session.leaseActive, false);
    assert.equal(session.page.retained, true);
  });
}

const linuxOnly = { skip: process.platform !== 'linux' };
const missingError = /\bENOENT: Trace session descriptor publication is missing\b/;
const retiredError = /\bOWNER_RETIRED: Original Trace browser and owner have exited\b/;

function assertMissingStatus(reply, proven = false) {
  const { alive, browserState, leaseState, controlAvailable, publicationState } = success(reply);
  assert.deepEqual({ alive, browserState, leaseState, controlAvailable, publicationState }, {
    alive: proven ? false : null, browserState: proven ? 'exited' : 'unknown',
    leaseState: proven ? 'revoked' : 'unknown', controlAvailable: false, publicationState: 'missing',
  });
}

test('missing legacy publication is unconfirmed and the same lease can be retried', async (t) => {
  const fixture = await openFixture(t);
  const session = await fixture.addSession('legacy-missing');
  await fixture.attach(session);
  await unlink(session.sessionPath);
  assertMissingStatus(await fixture.call(browserStatus));
  const problem = failure(await fixture.call(browserQuit));
  assert.match(problem, missingError);
  assert.doesNotMatch(problem, leaseEffects);
  assert.doesNotMatch(problem, /ruyi-borrowed-behaviors-/);
  assert.equal(session.leaseActive, true);
  await atomicJSON(session.sessionPath, session.descriptor);
  assertQuit(await fixture.call(browserQuit), 'lease_released');
  assert.equal(session.releaseAcks, 1);
});

for (const statusFirst of [true, false]) {
  test(`original failed Trace run locally detaches by ${statusFirst ? 'status then quit' : 'quit alone'}`, linuxOnly, async (t) => {
    const fixture = await openFixture(t);
    const crashed = await fixture.addSession('retiring', true);
    await fixture.attach(crashed);
    await unlink(crashed.sessionPath);
    await crashed.run.browser.stop();
    // Exercise both the single-acquisition crash and reconciliation after prior leases.
    await crashed.run.publishFailure({}, statusFirst ? {} : {
      mcp: { leasesAcquired: 4, leasesReleased: 2, leasesExpired: 1, leasesRevoked: 1 },
    });
    await crashed.run.worker.stop();
    await rmdir(crashed.run.control);
    const before = fixture.count();
    if (statusFirst) {
      assertMissingStatus(await fixture.call(browserStatus), true);
      assert.match(failure(await fixture.call(observe, scope(crashed))), retiredError);
      const reused = { ...crashed.descriptor, phase: 'observing' };
      await mkdir(crashed.run.control, { mode: 0o700 });
      await atomicJSON(crashed.sessionPath, reused);
      assertMissingStatus(await fixture.call(browserStatus), true); // The proven loss remains sticky.
      await unlink(crashed.sessionPath);
    }
    assertQuit(await fixture.call(browserQuit), 'lease_already_lost');
    assert.equal(fixture.count(), before, 'retirement never sends a release request or touches the old owner');
    assert.equal(crashed.releaseAcks, 0);
    assert.match(failure(await fixture.call('ruyi_attach_trace_session', { sessionPath: crashed.sessionPath })), missingError);
    const next = await fixture.addSession('after-crash', true);
    assert.equal((await fixture.attach(next)).runId, next.descriptor.runId);
    assertQuit(await fixture.call(browserQuit), 'lease_released');
    assert.equal(next.releaseAcks, 1);
  });
}

test('retirement proof rejects live, mismatched, unsafe, and replayed publications', linuxOnly, async (t) => {
  const fixture = await openFixture(t);
  const session = await fixture.addSession('negative-retirement', true);
  await fixture.attach(session);
  const run = session.run;
  await unlink(session.sessionPath);
  const before = fixture.count();
  async function remainsRetryable() {
    assertMissingStatus(await fixture.call(browserStatus));
    const problem = failure(await fixture.call(browserQuit));
    assert.match(problem, missingError);
    assert.doesNotMatch(problem, leaseEffects);
    assert.equal(fixture.count(), before);
  }
  await remainsRetryable(); // Missing without any final receipt.
  await run.publishFailure();
  await remainsRetryable(); // Both original generations are still live.
  await run.browser.stop();
  await remainsRetryable(); // The original owner generation can still finish cleanup.
  await run.worker.stop();
  for (const [state, result, embedded] of [
    [{ browser: { ...run.state.browser, startTime: '1' } }],
    [{ owner: { ...run.state.owner, startTime: '1' } }],
    [{ bootId: randomUUID() }],
    [{ pidNamespace: 'pid:[1]' }],
    [{ runtime: { ...run.state.runtime, build_id: '19990101123456' } }],
    [{ runtime: { ...run.state.runtime, executable_digests: { 'firefox-bin': 'b'.repeat(64) } } }],
    [{}, { runId: randomUUID() }],
    [{}, { completion: 'requested-stop' }],
    [{}, {}, { exit: 1 }],
    [{}, { mcp: { ...run.result.mcp, leasesRevoked: 0 } }],
  ]) {
    await run.publishFailure(state, result, embedded);
    await remainsRetryable();
  }
  await run.publishFailure();
  const extra = join(run.out, 'other-result.json');
  await rename(run.resultPath, extra);
  await symlink(extra, run.resultPath);
  await remainsRetryable();
  await unlink(run.resultPath);
  await link(extra, run.resultPath);
  await remainsRetryable();
  await unlink(run.resultPath);
  await writeFile(run.resultPath, Buffer.alloc(4 * 1024 * 1024 + 1), { mode: 0o600 });
  await remainsRetryable();
  await run.publishFailure();
  await chmod(run.statePath, 0o644);
  await remainsRetryable();
  await chmod(run.statePath, 0o600);

  // A replacement out directory can contain byte-for-byte valid receipts with
  // the original run ID, both of its old generations, and the same exact names.
  const oldOut = `${run.out}-original`;
  await rename(run.out, oldOut);
  await mkdir(run.out, { mode: 0o700 });
  await mkdir(run.control, { mode: 0o700 });
  await run.publishFailure();
  await remainsRetryable();
  await rename(run.out, `${run.out}-replacement`);
  await rename(oldOut, run.out);
  assertMissingStatus(await fixture.call(browserStatus), true);
  assertQuit(await fixture.call(browserQuit), 'lease_already_lost');
  assert.equal(session.releaseAcks, 0);
});
