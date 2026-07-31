import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--update-snapshot')) {
  throw new Error('Usage: node scripts/smoke-list-tools.mjs [--update-snapshot]');
}
const updateSnapshot = args[0] === '--update-snapshot';

const compareAscii = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareAscii)
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function serializeSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function updateSnapshotAtomically(snapshotPath, text) {
  await mkdir(dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, snapshotPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const snapshotPath = resolve(root, 'scripts/fixtures/tools-schema.snapshot.json');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'build/src/index.js')],
  cwd: root,
  stderr: 'pipe',
});
transport.stderr?.resume();
const client = new Client({ name: 'ruyi-mcp-smoke', version: '1.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  const result = await client.listTools();
  if (result.tools.length !== 59) {
    throw new Error(`Expected 59 tools, received ${result.tools.length}`);
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

  const names = result.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    throw new Error('tools/list contains duplicate tool names');
  }

  const snapshot = canonicalize({
    snapshotVersion: 1,
    tools: [...result.tools].sort((left, right) => compareAscii(left.name, right.name)),
  });
  const snapshotText = serializeSnapshot(snapshot);

  if (updateSnapshot) {
    await updateSnapshotAtomically(snapshotPath, snapshotText);
    console.log(`ruyi-mcp schema snapshot updated: ${snapshotPath}`);
  } else {
    let expectedText;
    try {
      expectedText = await readFile(snapshotPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Unable to read tool schema snapshot (${message}). `
          + 'Run npm run snapshot:tools to create it explicitly.'
      );
    }

    const expected = JSON.parse(expectedText);
    const canonicalExpectedText = serializeSnapshot(canonicalize(expected));
    if (expectedText !== canonicalExpectedText) {
      throw new Error(
        'Tool schema snapshot is not canonical. Run npm run snapshot:tools to rewrite it explicitly.'
      );
    }
    assert.deepStrictEqual(
      snapshot,
      expected,
      'Tool schema snapshot changed. Review the contract and run npm run snapshot:tools explicitly.'
    );
  }

  console.log(`ruyi-mcp smoke OK: ${result.tools.length} tools`);
} finally {
  await client.close();
}
