import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeDebuggerManager } from '../build/src/rdp/index.js';
import { requireGateFirefox } from './runtime-firefox.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const firefox = await requireGateFirefox();
const evidenceRoot = process.env.RUYI_RDP_EVIDENCE_ROOT || join(root, 'artifacts', 'rdp');
const fixtureId = `gate-${Date.now()}`;
const output = join(evidenceRoot, fixtureId);
await mkdir(output, { recursive: true });
const results = { schema: 'ruyi-rdp-runtime.v1', fixtureId, firefox, checks: [], diagnostics: [], startedAt: new Date().toISOString() };
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const javascript = [
  'window.firstRun = (window.firstRun || 0) + 1;',
  'window.targetFn = function targetFn(input) {',
  '  const local = input + 1;',
  '  window.lastResult = local * 2;',
  '  return window.lastResult;',
  '};',
  'window.closureFn = (() => { const secret = 73; return function closureFn(input) {',
  '  const object = {value: input, nested: {answer: secret}};',
  '  window.closureResult = object.value + secret;',
  '  return window.closureResult;',
  '}; })();',
  'window.raiseCaught = function raiseCaught() { try { throw new Error("caught-fixture"); } catch (error) { return error.message; } };',
  'window.raiseUncaught = function raiseUncaught() { setTimeout(() => { throw new Error("uncaught-fixture"); }, 0); };',
  'window.fetchFn = () => fetch("/api/data").then(response => response.text());',
  'window.xhrFn = () => { const request = new XMLHttpRequest(); request.open("GET", "/api/data"); request.send(); };',
  'window.asyncFn = async function asyncFn() { await Promise.resolve(); return targetFn(6); };',
  'document.querySelector("button").addEventListener("click", () => targetFn(4));',
  'window.evalFn = eval("(function evalInner(input) { const value = input + 5; return value; })");',
  'window.blobFn = () => import(URL.createObjectURL(new Blob(["export function blobTarget(value) { return value + 8; }"], {type:"text/javascript"})));',
  'window.workerFn = () => { window.worker = new Worker("/worker.js"); worker.onmessage = event => window.workerValue = event.data; worker.postMessage(11); };',
  'window.sharedFn = () => { window.shared = new SharedWorker("/shared.js"); shared.port.onmessage = event => window.sharedValue = event.data; shared.port.start(); shared.port.postMessage(12); };',
  'window.serviceFn = async () => { const registration = await navigator.serviceWorker.register("/service.js"); await navigator.serviceWorker.ready; registration.active.postMessage(13); };',
  '//# sourceMappingURL=/app.js.map',
].join('\n');
const worker = 'self.first = 1;\nonmessage = function workerMessage(event) {\n const value = event.data + 10;\n postMessage(value);\n};\n';
const shared = 'self.first = 2;\nonconnect = function sharedConnect(event) {\n const port = event.ports[0];\n port.onmessage = function sharedMessage(message) { const value = message.data + 20; port.postMessage(value); };\n port.start();\n};\n';
const service = 'self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));\nself.addEventListener("activate", event => event.waitUntil(self.clients.claim()));\nself.addEventListener("message", function serviceMessage(event) {\n const value = event.data + 30;\n self.lastValue = value;\n});\nself.addEventListener("fetch", event => { if (event.request.url.includes("/sw-data")) event.respondWith(new Response("sw-ok")); });\n';
const server = createHttpServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const bodies = {
    '/app.js': ['text/javascript', javascript], '/worker.js': ['text/javascript', worker], '/shared.js': ['text/javascript', shared], '/service.js': ['text/javascript', service],
    '/api/data': ['text/plain', 'xhr-ok'], '/app.js.map': ['application/json', JSON.stringify({ version: 3, sources: ['fixture.ts'], sourcesContent: [javascript], names: [], mappings: javascript.split('\n').map((_, index) => index ? 'AACA' : 'AAAA').join(';') })],
  };
  const [type, body] = bodies[path] || ['text/html', '<!doctype html><meta charset="utf-8"><title>native-rdp-fixture</title><button>target</button><div id="mutation">before</div><script src="/app.js"></script>'];
  response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); response.end(body);
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const portServer = createTcpServer();
await new Promise(resolveListen => portServer.listen(0, '127.0.0.1', resolveListen));
const port = portServer.address().port;
await new Promise(resolveClose => portServer.close(resolveClose));
const profile = join(output, 'profile');
await mkdir(profile);
await writeFile(join(profile, 'user.js'), [
  ['devtools.debugger.remote-enabled', true], ['devtools.chrome.enabled', true], ['devtools.debugger.prompt-connection', false], ['devtools.debugger.remote-port', port], ['devtools.debugger.force-local', true], ['browser.shell.checkDefaultBrowser', false], ['browser.startup.page', 0], ['browser.tabs.warnOnClose', false], ['dom.serviceWorkers.testing.enabled', true],
].map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'), 'utf8');
const browser = spawn(firefox, ['-no-remote', '-profile', profile, '-headless', '--start-debugger-server', String(port), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let outputText = '';
browser.stdout.on('data', data => { outputText += data.toString(); });
browser.stderr.on('data', data => { outputText += data.toString(); });
const manager = new NativeDebuggerManager(async () => ({ host: '127.0.0.1', port, owner: 'owned', pid: browser.pid, runId: fixtureId, runtime: { firefoxVersion: '159.0' } }));
manager.on('diagnostic', diagnostic => results.diagnostics.push(diagnostic));
manager.on('target', target => results.diagnostics.push({ event: 'target', ...target }));
manager.on('invalidated', error => results.diagnostics.push({ event: 'invalidated', message: error.message }));
async function check(name, operation) {
  const started = Date.now();
  try { const value = await operation(); results.checks.push({ name, passed: true, durationMs: Date.now() - started, value }); await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2), 'utf8'); return value; }
  catch (error) { results.checks.push({ name, passed: false, durationMs: Date.now() - started, error: { code: error.code, message: error.message, details: error.details } }); throw error; }
}
async function evaluate(expression) { return manager.call('debug.evaluate', { running: true, expression, allowSideEffects: true }); }
try {
  await check('attach-observe', async () => {
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { return await manager.attach({ scope: 'browser', includeSharedWorkers: true, sharedWorkerUrls: [`${origin}/shared.js`] }); }
      catch (error) { lastError = error; if (browser.exitCode !== null) throw new Error(`Firefox exited ${browser.exitCode}: ${outputText.slice(-1000)}`); await delay(250); }
    }
    throw lastError;
  });
  await check('navigate', async () => { await manager.call('debug.navigate', { url: origin }); await delay(600); return manager.status(); });
  const targets = manager.status().targets;
  const main = targets.find(target => target.type === 'frame' && target.url?.startsWith(origin));
  assert.ok(main, 'fixture main target missing');
  await manager.call('debug.select_target', { targetId: main.targetId });
  const sources = await check('sources', () => manager.sources({ urlContains: '/app.js' }));
  const source = sources.sources.find(source => source.url === `${origin}/app.js`);
  assert.ok(source, 'app.js source missing');
  await check('canary-breakpoint', async () => {
    await manager.arm();
    const breakpoint = await manager.setBreakpoint({ sourceActor: source.actor, line: 3 });
    const trigger = evaluate('setTimeout(() => targetFn(41), 0)');
    const paused = await manager.waitPaused({ timeout: 5 });
    assert.equal(paused.paused, true);
    const scope = await manager.scopes({ targetId: paused.targetId, pauseId: paused.pauseId });
    assert.equal(scope.scope.input, 41);
    await manager.resume(paused.targetId);
    await trigger;
    await manager.removeBreakpoint(breakpoint.breakpointId);
    return { why: paused.state.why, scopeInput: scope.scope.input };
  });
  const triggeredPause = async (expression, expected = 'breakpoint', targetId) => {
    const trigger = evaluate(`setTimeout(() => { ${expression}; }, 0)`);
    const paused = await manager.waitPaused({ targetId, timeout: 5 });
    assert.equal(paused.paused, true, `No pause for ${expression}`);
    if (expected) assert.equal(paused.state.why, expected);
    return { paused, trigger };
  };
  await check('conditions-false-true-throw', async () => {
    const breakpoint = await manager.setBreakpoint({ sourceActor: source.actor, line: 3, condition: 'input === 9' });
    await evaluate('setTimeout(() => targetFn(3), 0)');
    assert.equal((await manager.waitPaused({ timeout: 0 })).paused, false);
    const { paused, trigger } = await triggeredPause('targetFn(9)');
    await manager.resume(paused.targetId); await trigger; await manager.removeBreakpoint(breakpoint.breakpointId);
    const thrown = await manager.setBreakpoint({ sourceActor: source.actor, line: 3, condition: 'missingConditionFixture.value' });
    const failure = await triggeredPause('targetFn(2)', 'breakpointConditionThrown');
    await manager.resume(failure.paused.targetId); await failure.trigger; await manager.removeBreakpoint(thrown.breakpointId);
    return { falseSkipped: true, truePaused: true, thrownPaused: true };
  });
  await check('closure-eval-properties-stale-grip', async () => {
    const breakpoint = await manager.setBreakpoint({ sourceActor: source.actor, line: 9 });
    const { paused, trigger } = await triggeredPause('closureFn(5)');
    const scope = await manager.scopes({ pauseId: paused.pauseId });
    assert.equal(scope.scope.secret, 73);
    const evaluation = await manager.evaluate({ pauseId: paused.pauseId, expression: 'input + secret' });
    assert.equal(evaluation.result, 78);
    assert.ok(scope.scope.object.actor);
    const expanded = await manager.objects({ pauseId: paused.pauseId, actor: scope.scope.object.actor });
    assert.equal(expanded.value.ownProperties.value.value, 5);
    await manager.resume(paused.targetId); await trigger;
    await assert.rejects(manager.objects({ pauseId: paused.pauseId, actor: scope.scope.object.actor }));
    await manager.removeBreakpoint(breakpoint.breakpointId);
    return { closure: 73, evaluated: 78, property: 5, staleRejected: true };
  });
  await check('step-over-into-out-restart-run-to', async () => {
    const breakpoint = await manager.setBreakpoint({ sourceActor: source.actor, line: 3 });
    const { paused, trigger } = await triggeredPause('targetFn(8)');
    await manager.removeBreakpoint(breakpoint.breakpointId);
    const over = await manager.call('debug.step', { type: 'over', pauseId: paused.pauseId });
    assert.equal(over.paused, true);
    const into = await manager.call('debug.step', { type: 'into', pauseId: over.pauseId });
    assert.equal(into.paused, true);
    const restarted = await manager.call('debug.restart', { pauseId: into.pauseId });
    assert.equal(restarted.paused, true);
    const runTo = await manager.call('debug.run_to', { sourceActor: source.actor, line: 5, pauseId: restarted.pauseId });
    const reached = await manager.waitPaused({ timeout: 5 });
    assert.equal(reached.paused, true);
    const out = await manager.call('debug.step', { type: 'out', pauseId: reached.pauseId });
    if (out.paused) await manager.resume(out.targetId);
    await trigger;
    return { over: over.state.line, into: into.state.line, restarted: restarted.state.line, reached: reached.state.line, outPaused: out.paused, temporaryId: runTo.breakpointId };
  });
  await check('caught-uncaught-exceptions', async () => {
    await manager.call('debug.pause_on_exceptions', { enabled: true, ignoreCaught: false });
    const caught = await triggeredPause('raiseCaught()', 'exception');
    await manager.resume(caught.paused.targetId); await caught.trigger;
    await manager.call('debug.pause_on_exceptions', { enabled: true, ignoreCaught: true });
    await evaluate('setTimeout(() => raiseCaught(), 0)'); await delay(50);
    assert.equal((await manager.waitPaused({ timeout: 0 })).paused, false);
    const uncaught = await triggeredPause('raiseUncaught()', 'exception');
    await manager.resume(uncaught.paused.targetId); await uncaught.trigger;
    await manager.call('debug.pause_on_exceptions', { enabled: false });
    return { caught: true, ignoredCaught: true, uncaught: true };
  });
  await check('xhr-fetch-native', async () => {
    const breakpoint = await manager.call('debug.break_on_xhr', { url: '/api/data', method: 'GET' });
    for (const expression of ['xhrFn()', 'fetchFn()']) {
      const { paused, trigger } = await triggeredPause(expression, 'XHR');
      await manager.resume(paused.targetId); await trigger;
    }
    await manager.removeBreakpoint(breakpoint.breakpoints[0].breakpointId);
    return { xhr: true, fetch: true };
  });
  await check('logpoint-blackbox', async () => {
    const breakpoint = await manager.setBreakpoint({ sourceActor: source.actor, line: 3, logValue: 'input, "logpoint-fixture"' });
    await evaluate('setTimeout(() => targetFn(17), 0)'); await delay(80);
    assert.equal((await manager.waitPaused({ timeout: 0 })).paused, false);
    let logs = await manager.call('debug.logs');
    for (let attempt = 0; attempt < 20 && !JSON.stringify(logs).includes('logpoint-fixture'); attempt++) { await delay(25); logs = await manager.call('debug.logs'); }
    assert.ok(JSON.stringify(logs).includes('logpoint-fixture'), JSON.stringify(logs));
    await manager.removeBreakpoint(breakpoint.breakpointId);
    await manager.call('debug.blackbox', { sourceActor: source.actor });
    assert.equal((await manager.sources({ sourceActor: source.actor })).sources[0].isBlackBoxed, true);
    await manager.call('debug.blackbox', { sourceActor: source.actor, enabled: false });
    return { logpoint: true, blackbox: true };
  });
  await check('event-listener-dom-mutation', async () => {
    const events = await manager.call('debug.events');
    const event = events.value.flatMap(group => group.events).find(event => /(?:^|\.)click$/.test(event.id));
    assert.ok(event, 'click event category missing');
    await manager.call('debug.events', { ids: [event.id] });
    const clicked = await triggeredPause('document.querySelector("button").click()', 'eventBreakpoint');
    await manager.resume(clicked.paused.targetId); await clicked.trigger;
    await manager.call('debug.events', { ids: [] });
    const breakpoint = await manager.call('debug.dom', { selector: '#mutation', attribute: true });
    const mutation = await triggeredPause('document.querySelector("#mutation").setAttribute("data-test", "changed")', 'mutationBreakpoint');
    await manager.resume(mutation.paused.targetId); await mutation.trigger;
    await manager.removeBreakpoint(breakpoint.breakpointId);
    return { event: event.id, mutation: true };
  });
  await check('source-map-original-breakpoint', async () => {
    const map = await manager.call('debug.map_load', { sourceActor: source.actor, mapUrl: `${origin}/app.js.map`, allowRemote: true });
    const original = await manager.call('debug.map_original', { mapId: map.mapId, line: 3, column: 2 });
    assert.ok(original.source.endsWith('/fixture.ts'));
    const planted = await manager.call('debug.map_breakpoint', { mapId: map.mapId, source: original.source, line: 3, column: 0 });
    const { paused, trigger } = await triggeredPause('targetFn(27)');
    await manager.resume(paused.targetId); await trigger;
    for (const breakpoint of planted.breakpoints) await manager.removeBreakpoint(breakpoint.breakpointId);
    return { original, resolvedCount: planted.breakpoints.length };
  });
  await check('async-stack', async () => {
    const breakpoint = await manager.setBreakpoint({ sourceActor: source.actor, line: 3 });
    const { paused, trigger } = await triggeredPause('asyncFn()');
    const frames = await manager.frames({ pauseId: paused.pauseId });
    assert.ok(frames.frames.some(frame => frame.asyncCause || frame.state === 'suspended'), JSON.stringify(frames));
    await manager.resume(paused.targetId); await trigger; await manager.removeBreakpoint(breakpoint.breakpointId);
    return { frameCount: frames.frames.length, asyncFrames: frames.frames.filter(frame => frame.asyncCause || frame.state === 'suspended').map(frame => ({ name: frame.displayName, state: frame.state, asyncCause: frame.asyncCause })) };
  });
  await check('eval-blob-source-identity', async () => {
    const evalSources = (await manager.sources()).sources.filter(source => source.introductionType === 'eval');
    let evalSource;
    for (const candidate of evalSources) {
      const body = await manager.sourceText({ sourceActor: candidate.actor });
      if (body.source?.includes('function evalInner')) { evalSource = candidate; break; }
    }
    assert.ok(evalSource);
    const positions = await manager.positions({ sourceActor: evalSource.actor });
    const column = positions.positions['1'].find(column => column > 30) ?? positions.positions['1'][0];
    const breakpoint = await manager.setBreakpoint({ sourceActor: evalSource.actor, line: 1, column });
    const { paused, trigger } = await triggeredPause('evalFn(2)');
    assert.equal(paused.state.sourceActor, evalSource.actor);
    await manager.resume(paused.targetId); await trigger; await manager.removeBreakpoint(breakpoint.breakpointId);
    await evaluate('blobFn().then(module => window.blobTarget = module.blobTarget)'); await delay(100);
    const blobSource = (await manager.sources()).sources.find(source => source.url?.startsWith('blob:'));
    assert.ok(blobSource);
    const blobBreakpoint = await manager.setBreakpoint({ sourceActor: blobSource.actor, line: 1 });
    const blob = await triggeredPause('blobTarget(5)');
    assert.equal(blob.paused.state.sourceActor, blobSource.actor);
    await manager.resume(blob.paused.targetId); await blob.trigger; await manager.removeBreakpoint(blobBreakpoint.breakpointId);
    return { eval: true, blob: true };
  });
  await check('dedicated-shared-service-workers', async () => {
    const workerResults = [];
    for (const [kind, script, line, expression, column] of [
      ['worker', '/worker.js', 3, 'workerFn()', worker.split('\n')[2].indexOf('event.data')],
      ['shared_worker', '/shared.js', 4, 'sharedFn()', shared.split('\n')[3].indexOf('message.data')],
      ['service_worker', '/service.js', 4, 'serviceFn()', service.split('\n')[3].indexOf('event.data')],
    ]) {
      const breakpoint = await manager.setBreakpoint({ url: origin + script, line, column });
      const triggered = evaluate(`setTimeout(() => { ${expression}; }, 0)`);
      const paused = await manager.waitPaused({ timeout: 8 });
      assert.equal(paused.paused, true, `${kind} pause missing: ${JSON.stringify(manager.status())}`);
      const target = manager.status().targets.find(target => target.targetId === paused.targetId);
      assert.equal(target.type, kind);
      const scope = await manager.scopes({ targetId: target.targetId, pauseId: paused.pauseId });
      const frames = await manager.frames({ targetId: target.targetId, pauseId: paused.pauseId });
      assert.ok(frames.frames.length);
      await manager.resume(target.targetId); await triggered;
      await manager.removeBreakpoint(breakpoint.breakpointId);
      await assert.rejects(manager.call('debug.break_on_xhr', { targetId: target.targetId, url: '/api' }), error => error.code === 'UNSUPPORTED');
      workerResults.push({ kind, pauseReason: paused.state.why, keys: Object.keys(scope.scope) });
    }
    return workerResults;
  });
  await check('cross-origin-iframe', async () => {
    const frameUrl = origin.replace('127.0.0.1', 'localhost') + '/frame';
    await evaluate(`(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(frameUrl)}; document.body.appendChild(frame); })()`);
    await delay(700);
    const frame = manager.status().targets.find(target => target.type === 'frame' && target.url === frameUrl);
    assert.ok(frame, JSON.stringify(manager.status()));
    const frameSource = (await manager.sources({ targetId: frame.targetId })).sources.find(source => source.url?.endsWith('/app.js'));
    assert.ok(frameSource);
    const breakpoint = await manager.setBreakpoint({ targetId: frame.targetId, sourceActor: frameSource.actor, line: 3 });
    const trigger = manager.evaluate({ targetId: frame.targetId, running: true, expression: 'setTimeout(() => targetFn(31), 0)', allowSideEffects: true });
    const paused = await manager.waitPaused({ targetId: frame.targetId, timeout: 5 });
    assert.equal(paused.paused, true);
    const scope = await manager.scopes({ targetId: frame.targetId, pauseId: paused.pauseId });
    assert.equal(scope.scope.input, 31);
    await manager.resume(frame.targetId); await trigger; await manager.removeBreakpoint(breakpoint.breakpointId);
    return { separateTarget: true, input: 31 };
  });
  await check('first-statement-navigation', async () => {
    const breakpoint = await manager.setBreakpoint({ url: `${origin}/app.js`, line: 1, column: 0 });
    const navigation = manager.call('debug.navigate', { url: origin + '/reload' });
    const paused = await manager.waitPaused({ timeout: 15 });
    assert.equal(paused.paused, true);
    assert.equal(paused.state.line, 1);
    await manager.resume(paused.targetId); await navigation;
    await manager.removeBreakpoint(breakpoint.breakpointId);
    return { firstStatement: true, targetReplaced: paused.targetId !== main.targetId };
  });
  await check('wasm-binary-js-boundary', async () => {
    const fixture = [0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11];
    await evaluate(`WebAssembly.instantiate(new Uint8Array(${JSON.stringify(fixture)})).then(result => { window.wasmAdd = result.instance.exports.add; window.wasmResult = wasmAdd(20,22); })`);
    await delay(80);
    const sourceList = await manager.sources();
    const wasmSource = sourceList.sources.find(source => source.introductionType === 'wasm' || source.url?.startsWith('wasm:'));
    assert.ok(wasmSource, JSON.stringify(sourceList));
    const binary = await manager.sourceText({ sourceActor: wasmSource.actor });
    assert.equal(binary.sourceType, 'wasm');
    const value = await evaluate('wasmResult');
    assert.equal(value.result, 42);
    return { bytes: binary.byteLength, exported: binary.data, jsResult: 42 };
  });
  await check('target-identity-and-reconnect', async () => {
    await assert.rejects(manager.attach({ browserId: 999999 }), error => error.code === 'SESSION_ACTIVE');
    const epoch = manager.status().epoch;
    await manager.close();
    await manager.attach({ scope: 'browser', includeSharedWorkers: true, sharedWorkerUrls: [`${origin}/shared.js`], autoResumeAfter: 1 });
    assert.notEqual(manager.status().epoch, epoch);
    await manager.arm();
    const source = (await manager.sources({ urlContains: '/app.js' })).sources[0];
    const breakpoint = await manager.setBreakpoint({ sourceActor: source.actor, line: 3 });
    const trigger = evaluate('setTimeout(() => targetFn(18), 0)');
    const paused = await manager.waitPaused({ timeout: 5 });
    assert.equal(paused.paused, true);
    await delay(1200);
    assert.equal((await manager.waitPaused({ timeout: 0 })).paused, false);
    await assert.rejects(manager.scopes({ pauseId: paused.pauseId }), error => error.code === 'NOT_PAUSED');
    await trigger;
    await manager.removeBreakpoint(breakpoint.breakpointId);
    return { identityMismatchRejected: true, epochChanged: true, watchdogResumed: true, stalePauseRejected: true };
  });
  results.ok = true;
} catch (error) {
  results.ok = false; results.error = { message: error.message, stack: error.stack, code: error.code, details: error.details };
} finally {
  await manager.close();
  if (browser.exitCode === null) browser.kill();
  await new Promise(resolveClose => server.close(resolveClose));
  await writeFile(join(output, 'browser.log'), outputText, 'utf8');
  results.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: results.ok, evidence: join(output, 'results.json'), checks: results.checks.map(check => ({ name: check.name, passed: check.passed })), error: results.error?.message }));
}
process.exitCode = results.ok ? 0 : 1;
