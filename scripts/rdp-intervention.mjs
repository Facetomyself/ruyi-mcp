import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeDebuggerManager } from '../build/src/rdp/index.js';
import { requireGateFirefox } from './runtime-firefox.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const firefox = await requireGateFirefox();
const evidenceRoot = process.env.RUYI_RDP_INTERVENTION_ROOT || join(root, 'artifacts', 'rdp-intervention');
const fixtureId = `intervention-${Date.now()}`;
const output = join(evidenceRoot, fixtureId);
await mkdir(output, { recursive: true });

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const probeSource = `
window.targetFn = function targetFn(input) {
  const local = input + 1;
  window.targetResult = local * 2;
  return window.targetResult;
};
window.debuggerProbe = function debuggerProbe() {
  const value = 17;
  debugger;
  return value;
};
`;
const targetLine = probeSource.split('\n').findIndex(line => line.includes('const local = input + 1')) + 1;

const page = `<!doctype html>
<meta charset="utf-8">
<title>intervention-fixture</title>
<button id="button">target</button>
<script>
const delayMs = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(path, payload = {}) {
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
  if (!response.ok) throw new Error(path + ' HTTP ' + response.status);
  return response.json();
}
function fingerprint() {
  return {
    fetchSource: Function.prototype.toString.call(fetch),
    xhrSource: Function.prototype.toString.call(XMLHttpRequest.prototype.open),
    navigator: {platform: navigator.platform, language: navigator.language, hardwareConcurrency: navigator.hardwareConcurrency},
    viewport: {innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio},
    focus: {hasFocus: document.hasFocus(), visibility: document.visibilityState},
    marker: Object.keys(window).includes('targetFn')
  };
}
function instrument() {
  let last = performance.now();
  let ticks = 0;
  let maximumLagMs = 0;
  const started = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maximumLagMs = Math.max(maximumLagMs, now - last - 10);
    last = now;
    ticks += 1;
  }, 10);
  return () => {
    clearInterval(timer);
    const elapsedMs = performance.now() - started;
    return {ticks, elapsedMs, maximumLagMs};
  };
}
(async () => {
  await post('/ready', {fingerprint: fingerprint()});
  let gateState;
  while (!(gateState = await post('/gate')).go) await delayMs(25);
  const gate = gateState;
  const afterGate = fingerprint();
  const stop = instrument();
  await delayMs(150);
  let debuggerProbeResult = null;
  if (gate.debuggerProbe) debuggerProbeResult = window.debuggerProbe();
  let targetCall = null;
  let targetCallError = null;
  try {
    if (gate.trigger) targetCall = window.targetFn(41);
  } catch (error) {
    targetCallError = String(error && error.stack || error);
  }
  const work = await fetch('/work').then(async response => ({status: response.status, body: await response.text()}));
  await delayMs(1050);
  const eventLoop = stop();
  const final = {
    afterGate,
    eventLoop,
    work,
    gateState,
    targetCall,
    targetCallError,
    targetResult: window.targetResult ?? null,
    debuggerProbeResult
  };
  await post('/final', final);
})().catch(error => post('/error', {message: String(error && error.stack || error)}));
</script>`;

async function reservePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function runMode(mode) {
  const reservedPort = mode === 'baseline' ? null : await reservePort();
  let readyResolve;
  let finalResolve;
  let errorReject;
  let gateOpen = false;
  const ready = new Promise(resolveReady => { readyResolve = resolveReady; });
  const final = new Promise((resolveFinal, rejectFinal) => { finalResolve = resolveFinal; errorReject = rejectFinal; });
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'POST' && ['/ready', '/gate', '/final', '/error'].includes(path)) {
      let text = '';
      for await (const chunk of request) text += chunk.toString();
      const payload = text ? JSON.parse(text) : {};
      response.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      if (path === '/ready') { readyResolve(payload); response.end('{"ok":true}'); return; }
      if (path === '/gate') { response.end(JSON.stringify({go: gateOpen, trigger: true, debuggerProbe: mode === 'observe'})); return; }
      if (path === '/final') { finalResolve(payload); response.end('{"ok":true}'); return; }
      response.end('{"ok":false}');
      errorReject(new Error(payload.message || 'page error'));
      return;
    }
    if (path === '/work') {
      requests.push({method: request.method, url: path, at: performance.now()});
      response.writeHead(200, {'content-type': 'text/plain', 'cache-control': 'no-store'});
      response.end('work-ok');
      return;
    }
    if (path === '/probe.js') {
      response.writeHead(200, {'content-type': 'text/javascript', 'cache-control': 'no-store'});
      response.end(probeSource);
      return;
    }
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    response.end(page.replace('<button id="button">target</button>', '<button id="button">target</button><script src="/probe.js"></script>'));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = join(output, `${mode}-profile`);
  await mkdir(profile);
  await writeFile(join(profile, 'user.js'), [
    ['devtools.debugger.remote-enabled', true],
    ['devtools.chrome.enabled', true],
    ['devtools.debugger.prompt-connection', false],
    ['devtools.debugger.force-local', true],
    ['browser.shell.checkDefaultBrowser', false],
    ['browser.startup.page', 0],
    ['browser.tabs.warnOnClose', false],
  ].map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'), 'utf8');
  const args = ['-no-remote', '-profile', profile, '-headless'];
  if (reservedPort) args.push('--start-debugger-server', String(reservedPort));
  args.push(origin);
  const browser = spawn(firefox, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let browserLog = '';
  browser.stdout.on('data', data => { browserLog += data.toString(); });
  browser.stderr.on('data', data => { browserLog += data.toString(); });
  const manager = reservedPort ? new NativeDebuggerManager(async () => ({
    host: '127.0.0.1', port: reservedPort, owner: 'owned', pid: browser.pid, runId: `${fixtureId}-${mode}`,
    runtime: {firefoxVersion: '159.0'},
  })) : null;
  const result = {mode, rdpServer: Boolean(reservedPort), attached: mode === 'observe' || mode === 'pause'};
  try {
    const initial = await Promise.race([ready, delay(15000).then(() => { throw new Error(`${mode}: page ready timeout`); })]);
    if (manager && mode !== 'server-only') {
      await manager.attach({mode: 'observe', autoResumeAfter: 30});
      result.attachStatus = manager.status();
      if (mode === 'pause') {
        const source = (await manager.sources({urlContains: '/probe.js'})).sources.find(item => item.url === `${origin}/probe.js`);
        assert.ok(source, `${mode}: probe source missing`);
        result.breakpoint = await manager.setBreakpoint({sourceActor: source.actor, line: targetLine});
        await manager.arm();
        result.pauseWait = manager.waitPaused({timeout: 10});
      }
    }
    gateOpen = true;
    if (mode === 'pause') {
      const paused = await result.pauseWait;
      const pausedAt = performance.now();
      assert.equal(paused.paused, true, `${mode}: expected a native pause`);
      result.pause = paused;
      const scope = await manager.scopes({targetId: paused.targetId, pauseId: paused.pauseId});
      result.pauseState = paused.state;
      result.scope = scope.scope;
      result.scopeInput = scope.scope?.input;
      assert.equal(scope.scope?.input, 41);
      await manager.resume(paused.targetId);
      result.pauseDurationMs = performance.now() - pausedAt;
      result.stage = 'resumed';
    }
    const finalPayload = await Promise.race([final, delay(15000).then(() => { throw new Error(`${mode}: page final timeout`); })]);
    result.stage = 'final';
    const afterGateHash = digest(finalPayload.afterGate);
    result.initialFingerprintHash = digest(initial.fingerprint);
    result.afterGateFingerprintHash = afterGateHash;
    result.afterGate = finalPayload.afterGate;
    result.eventLoop = finalPayload.eventLoop;
    result.work = finalPayload.work;
    result.workRequestCount = requests.length;
    result.targetResult = finalPayload.targetResult;
    result.nativePauseObserved = Boolean(result.pause);
    result.pausedAtEnd = manager ? manager.status().targets.some(target => target.paused) : false;
    result.passed = finalPayload.work.status === 200
      && finalPayload.work.body === 'work-ok'
      && finalPayload.targetResult === 84
      && !result.pausedAtEnd
      && (mode !== 'pause' || result.pauseDurationMs >= 0 && result.scopeInput === 41);
    if (mode === 'observe') {
      result.debuggerStatementStayedRunning = !result.pausedAtEnd;
      result.passed = result.passed && result.debuggerStatementStayedRunning;
    }
  } catch (error) {
    result.passed = false;
    result.error = {message: error.message, stack: error.stack};
    result.managerStatus = manager?.status();
  } finally {
    if (manager) await manager.close().catch(() => {});
    gateOpen = false;
    if (browser.exitCode === null) browser.kill();
    await delay(100);
    await new Promise(resolveClose => server.close(resolveClose));
    await writeFile(join(output, `${mode}.browser.log`), browserLog, 'utf8');
  }
  return result;
}

const report = {
  schema: 'ruyi-rdp-intervention.v1',
  fixtureId,
  firefox,
  startedAt: new Date().toISOString(),
  modes: [],
  ok: false,
};
try {
  const requestedModes = (process.env.RUYI_RDP_INTERVENTION_MODES || 'baseline,server-only,observe,pause').split(',').map(value => value.trim()).filter(Boolean);
  for (const mode of requestedModes) {
    report.modes.push(await runMode(mode));
  }
  const baseline = report.modes.find(mode => mode.mode === 'baseline') || report.modes[0];
  for (const mode of report.modes.slice(1)) {
    assert.equal(mode.afterGateFingerprintHash, baseline.afterGateFingerprintHash, `${mode.mode}: post-attach API/viewport/focus fingerprint changed`);
    assert.equal(mode.work.status, 200);
    assert.equal(mode.work.body, 'work-ok');
    assert.equal(mode.targetResult, 84);
  }
  report.comparison = report.modes.filter(mode => mode.eventLoop).map(mode => ({
    mode: mode.mode,
    fingerprintStable: mode.afterGateFingerprintHash === baseline.afterGateFingerprintHash,
    maximumLagMs: mode.eventLoop.maximumLagMs,
    ticks: mode.eventLoop.ticks,
    elapsedMs: mode.eventLoop.elapsedMs,
    pauseDurationMs: mode.pauseDurationMs ?? null,
    nativePauseObserved: mode.nativePauseObserved,
  }));
  report.ok = report.modes.length === 4 && report.modes.every(mode => mode.passed);
  if (!report.ok) throw new Error('one or more intervention modes failed');
} catch (error) {
  report.error = {message: error.message, stack: error.stack};
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ok: report.ok, evidence: join(output, 'results.json'), comparison: report.comparison, error: report.error?.message}));
}
process.exitCode = report.ok ? 0 : 1;
