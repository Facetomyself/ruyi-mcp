import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bridgeModuleUrl = process.env.RUYI_MCP_BRIDGE_MODULE
  ? pathToFileURL(resolve(process.env.RUYI_MCP_BRIDGE_MODULE)).href
  : new URL('../build/src/bridge/python.js', import.meta.url).href;
const { PythonBridge } = await import(bridgeModuleUrl);

const fixture = fileURLToPath(new URL('./fixtures/bridge-lifecycle-fixture.mjs', import.meta.url));
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await delay(5);
  }
  assert.ok(predicate(), message);
}

test('child stdin EPIPE rejects all pending bridge calls without crashing', async () => {
  const bridge = new PythonBridge({ executable: process.execPath, script: fixture });
  await bridge.start();

  try {
    const startedAt = Date.now();
    const pending = [
      bridge.call('fixture.hang_one', {}, 1000),
      bridge.call('fixture.hang_two', {}, 1000),
    ];
    const epipe = Object.assign(new Error('synthetic child stdin EPIPE'), { code: 'EPIPE' });
    bridge.proc.stdin.destroy(epipe);
    const results = await Promise.allSettled(pending);
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 900, `bridge calls were not rejected promptly (${elapsedMs}ms)`);
    assert.ok(results.every((result) => result.status === 'rejected'));
    for (const result of results) {
      assert.match(String(result.reason), /stdin|EPIPE|terminated|exited|writable/i);
    }
  } finally {
    await Promise.all([bridge.stop(), bridge.stop()]);
  }

  assert.equal(bridge.isRunning(), false);
});

test('restart isolates new pending calls from a stale child exit after stdin EPIPE', async () => {
  const bridge = new PythonBridge({ executable: process.execPath, script: fixture });
  await bridge.start();

  const staleChild = bridge.proc;
  const staleExitListeners = staleChild.listeners('exit');
  assert.ok(staleExitListeners.length > 0, 'bridge did not register a child exit listener');

  // Hold this generation's real exit delivery so the test can deterministically
  // replay it after the replacement child already owns a pending request.
  staleChild.removeAllListeners('exit');

  try {
    const staleCall = bridge.call('fixture.hang_stale_generation', {}, 1000);
    await waitFor(
      () => bridge.pending.size === 1,
      'stale generation did not register its pending request'
    );

    const epipe = Object.assign(new Error('synthetic child stdin EPIPE'), { code: 'EPIPE' });
    staleChild.stdin.destroy(epipe);
    await assert.rejects(staleCall, /stdin|EPIPE|terminated|exited|writable/i);
    await waitFor(() => bridge.proc === null, 'EPIPE did not detach the stale child');

    const restartedCall = bridge.call('fixture.hang_restarted_generation', {}, 1000);
    await waitFor(
      () => bridge.proc !== null
        && bridge.proc !== staleChild
        && bridge.isRunning()
        && bridge.pending.size === 1,
      'replacement generation did not become ready with a pending request'
    );

    const activeChild = bridge.proc;
    const activeRequestId = bridge.nextId;
    for (const listener of staleExitListeners) {
      listener.call(staleChild, 0, null);
    }

    assert.equal(bridge.proc, activeChild, 'stale exit replaced the active child reference');
    assert.equal(
      bridge.pending.has(activeRequestId),
      true,
      'stale exit rejected the replacement generation request'
    );

    activeChild.stdout.emit('data', Buffer.from(`${JSON.stringify({
      id: activeRequestId,
      result: { ok: true, generation: 'replacement' },
    })}\n`));
    assert.deepEqual(await restartedCall, { ok: true, generation: 'replacement' });
  } finally {
    await bridge.stop();
  }

  assert.equal(bridge.isRunning(), false);
});
