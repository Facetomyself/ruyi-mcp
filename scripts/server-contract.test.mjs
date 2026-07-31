import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cleanupServer, createServer } from '../build/src/server.js';

class FakeBridge {
  constructor(name) {
    this.name = name;
    this.calls = [];
    this.stopCalls = 0;
    this.running = true;
  }

  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'browser.status') {
      return { alive: false, bridge: this.name };
    }
    return { ok: true, bridge: this.name, method };
  }

  async stop() {
    this.stopCalls += 1;
    this.running = false;
  }

  isRunning() {
    return this.running;
  }
}

async function connect(server, clientName) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('createServer isolates tool handlers and cleanup per instance', async () => {
  const bridgeA = new FakeBridge('A');
  const bridgeB = new FakeBridge('B');
  const serverA = await createServer(bridgeA);
  const serverB = await createServer(bridgeB);
  const clientA = await connect(serverA, 'client-a');
  const clientB = await connect(serverB, 'client-b');

  try {
    const toolsA = await clientA.listTools();
    const toolsB = await clientB.listTools();
    assert.equal(toolsA.tools.length, 59);
    assert.equal(toolsB.tools.length, 59);
    assert.equal(new Set(toolsA.tools.map((tool) => tool.name)).size, 59);
    assert.equal(new Set(toolsB.tools.map((tool) => tool.name)).size, 59);

    const statusA = await clientA.callTool({ name: 'ruyi_browser_status', arguments: {} });
    const statusB = await clientB.callTool({ name: 'ruyi_browser_status', arguments: {} });
    assert.equal(JSON.parse(statusA.content[0].text).bridge, 'A');
    assert.equal(JSON.parse(statusB.content[0].text).bridge, 'B');
    assert.equal(bridgeA.calls.filter((call) => call.method === 'browser.status').length, 1);
    assert.equal(bridgeB.calls.filter((call) => call.method === 'browser.status').length, 1);
  } finally {
    await Promise.allSettled([clientA.close(), clientB.close()]);
    await Promise.all([
      cleanupServer(serverA),
      cleanupServer(serverA),
      cleanupServer(serverB),
      cleanupServer(serverB),
    ]);
  }

  assert.equal(bridgeA.stopCalls, 1);
  assert.equal(bridgeB.stopCalls, 1);
  assert.equal(bridgeA.calls.filter((call) => call.method === 'browser.quit').length, 1);
  assert.equal(bridgeB.calls.filter((call) => call.method === 'browser.quit').length, 1);
});
