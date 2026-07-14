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
  if (result.tools.length !== 56) {
    throw new Error(`Expected 56 tools, received ${result.tools.length}`);
  }
  console.log(`ruyi-mcp smoke OK: ${result.tools.length} tools`);
} finally {
  await client.close();
}
