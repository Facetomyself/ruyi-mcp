import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'build/src/index.js')],
  cwd: root,
  stderr: 'pipe',
});
const client = new Client({ name: 'ruyi-mcp-smoke', version: '1.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  const result = await client.listTools();
  if (result.tools.length !== 57) {
    throw new Error(`Expected 57 tools, received ${result.tools.length}`);
  }
  const humanDrag = result.tools.find((tool) => tool.name === 'ruyi_human_drag');
  if (!humanDrag) {
    throw new Error('ruyi_human_drag is not registered');
  }
  const fingerprint = result.tools.find((tool) => tool.name === 'ruyi_set_fingerprint');
  if (!fingerprint?.inputSchema?.properties?.windowSize) {
    throw new Error('ruyi_set_fingerprint.windowSize is not exposed');
  }
  if (!fingerprint?.inputSchema?.properties?.screenSize) {
    throw new Error('ruyi_set_fingerprint.screenSize is not exposed');
  }
  if (!fingerprint?.inputSchema?.properties?.viewport?.properties?.devicePixelRatio) {
    throw new Error('ruyi_set_fingerprint.viewport.devicePixelRatio is not exposed');
  }
  const selectFrame = result.tools.find((tool) => tool.name === 'ruyi_select_frame');
  if (!selectFrame?.inputSchema?.properties?.selector) {
    throw new Error('ruyi_select_frame.selector is not exposed');
  }
  if (!Array.isArray(selectFrame.inputSchema.oneOf) || selectFrame.inputSchema.oneOf.length !== 2) {
    throw new Error('ruyi_select_frame contextId/selector exclusivity is not exposed');
  }
  const captureStop = result.tools.find((tool) => tool.name === 'ruyi_capture_stop');
  const cleanupTimeout = captureStop?.inputSchema?.properties?.cleanupTimeout;
  if (!cleanupTimeout || cleanupTimeout.minimum !== 0.1 || cleanupTimeout.maximum !== 30) {
    throw new Error('ruyi_capture_stop.cleanupTimeout bounds are not exposed');
  }
  console.log(`ruyi-mcp smoke OK: ${result.tools.length} tools`);
} finally {
  await client.close();
}
