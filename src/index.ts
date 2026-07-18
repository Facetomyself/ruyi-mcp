#!/usr/bin/env node
/**
 * Community MCP server for ruyiPage browser automation and inspection.
 *
 * Start with:
 *   node build/src/index.js
 * or configure the same entry point in an MCP client.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { PythonBridge } from './bridge/python.js';

async function main(): Promise<void> {
  console.error('[ruyi-mcp] Starting ruyi-mcp v0.1.3...');
  console.error('[ruyi-mcp] Browser: Firefox runtime managed by ruyiPage');
  console.error('[ruyi-mcp] Protocol: WebDriver BiDi');
  console.error('[ruyi-mcp] Capabilities: automation, network inspection, fingerprint analysis, human-like interaction');
  console.error('[ruyi-mcp] Trace: ruyiPage WebDriver BiDi JSON Trace');

  const bridge = new PythonBridge();
  let shuttingDown = false;

  async function shutdown(signal: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[ruyi-mcp] ${signal} received`);
    await bridge.stop().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ruyi-mcp] Bridge stop failed: ${message}`);
    });
    process.exit(code);
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  try {
    const server = await createServer(bridge);
    const transport = new StdioServerTransport();

    console.error('[ruyi-mcp] Connecting to MCP transport...');
    await server.connect(transport);

    console.error('[ruyi-mcp] Ready. Waiting for MCP requests...');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ruyi-mcp] Fatal: ${message}`);
    await bridge.stop().catch(() => {});
    process.exit(1);
  }
}

main();
