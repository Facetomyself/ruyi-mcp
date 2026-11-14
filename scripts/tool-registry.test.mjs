import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../build/src/tool-registry.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, cleanupServer } from '../build/src/server.js';

test('discovery executes hidden tools with their full strict schema', async () => {
  const registry = new ToolRegistry();
  const calls = [];
  registry.register({
    tool: { name: 'fixture_nested', description: 'nested automation operation', inputSchema: {
      type: 'object', properties: { config: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }, required: ['config'],
    } },
    handler: async args => { calls.push(args); return { content: [{ type: 'text', text: 'done' }] }; },
  });
  registry.registerDiscovery();
  const found = await registry.execute('ruyi_search_tools', { query: 'fixture_nested' });
  const tool = JSON.parse(found.content[0].text).tools[0];
  assert.equal(tool.inputSchema.properties.config.additionalProperties, false);
  await registry.execute('ruyi_execute_tool', { name: tool.name, arguments: { config: { count: 2 } } });
  assert.equal(calls.length, 1);
  for (const args of [{ config: { count: '2' } }, { config: { count: 0 } }, { config: { count: 2, extra: true } }, { config: { count: 2 }, unexpected: 1 }, {}]) {
    await assert.rejects(registry.execute('ruyi_execute_tool', { name: tool.name, arguments: args }), /Invalid arguments/);
  }
  assert.equal(calls.length, 1);
  await assert.rejects(registry.execute('ruyi_execute_tool', { name: 'ruyi_execute_tool', arguments: {} }), /Recursive/);
  await assert.rejects(registry.execute('ruyi_execute_tool', { name: 'missing', arguments: {} }), /Unknown tool/);
});

test('compact exposes five schemas but keeps automation and native debug reachable', async () => {
  process.env.RUYI_MCP_TOOLSET = 'compact';
  const calls = [];
  const bridge = {
    call: async (method, params) => { calls.push({ method, params }); return { alive: false }; },
    isRunning: () => false,
    stop: async () => {},
  };
  const server = await createServer(bridge);
  const client = new Client({ name: 'compact-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.equal((await client.listTools()).tools.length, 5);
    const search = await client.callTool({ name: 'ruyi_search_tools', arguments: { query: 'ruyi_debug_set_breakpoint' } });
    const matches = JSON.parse(search.content[0].text).tools;
    assert.equal(matches[0].name, 'ruyi_debug_set_breakpoint');
    const status = await client.callTool({ name: 'ruyi_execute_tool', arguments: { name: 'ruyi_debug_status', arguments: {} } });
    assert.notEqual(status.isError, true);
    const invalid = await client.callTool({ name: 'ruyi_execute_tool', arguments: { name: 'ruyi_navigate_page', arguments: { url: 'http://fixture.invalid', injected: true } } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await client.close();
    await cleanupServer(server);
    delete process.env.RUYI_MCP_TOOLSET;
  }
});
