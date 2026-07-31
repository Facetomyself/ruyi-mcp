import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entryPoint = resolve(root, 'build/src/index.js');
const bridgeFixture = resolve(root, 'scripts/fixtures/bridge-lifecycle-fixture.mjs');
const fixtureEnv = {
  RUYI_MCP_PYTHON: process.execPath,
  RUYI_MCP_BRIDGE_SCRIPT: bridgeFixture,
};

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const occurrences = (text, pattern) => text.match(pattern)?.length ?? 0;

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openActiveClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd: root,
    stderr: 'pipe',
    env: fixtureEnv,
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const status = await client.callTool({ name: 'ruyi_browser_status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).fixture, true);
  return { client, transport, getStderr: () => stderr };
}

test('stdin EOF cleans up an active bridge without the client force-kill timeout', async () => {
  const session = await openActiveClient('stdin-eof-test');
  const startedAt = Date.now();
  await session.client.close();
  const elapsedMs = Date.now() - startedAt;
  const stderr = session.getStderr();

  assert.ok(elapsedMs < 1500, `stdin EOF cleanup took ${elapsedMs}ms`);
  assert.equal(occurrences(stderr, /stdin EOF received/g), 1);
  assert.equal(occurrences(stderr, /Server closing, cleaning up/g), 1);
});

test('SIGTERM and transport close share one cleanup owner', {
  skip: process.platform === 'win32' ? 'Windows child.kill does not deliver a catchable SIGTERM' : false,
}, async () => {
  const session = await openActiveClient('signal-race-test');
  const pid = session.transport.pid;
  assert.ok(pid);

  process.kill(pid, 'SIGTERM');
  await session.client.close();
  const stderr = session.getStderr();

  assert.equal(occurrences(stderr, /(?:SIGTERM|stdin EOF|MCP transport closed) received/g), 1);
  assert.equal(occurrences(stderr, /Server closing, cleaning up/g), 1);
});

test('closed MCP stdout is handled as EPIPE instead of an uncaught stream error', async (t) => {
  const child = spawn(process.execPath, [entryPoint], {
    cwd: root,
    env: { ...process.env, ...fixtureEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  const closePromise = new Promise((resolveClose) => {
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const readyDeadline = Date.now() + 1500;
  while (!stderr.includes('Ready. Waiting for MCP requests...') && Date.now() < readyDeadline) {
    await delay(10);
  }
  assert.match(stderr, /Ready\. Waiting for MCP requests/);

  child.stdout.destroy();
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'epipe-test', version: '1.0.0' },
    },
  })}\n`);

  const result = await withTimeout(closePromise, 1500, 'server did not exit after stdout EPIPE');

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(occurrences(stderr, /stdout EPIPE received/g), 1);
  assert.doesNotMatch(stderr, /Unhandled 'error' event|uncaught/i);
});
