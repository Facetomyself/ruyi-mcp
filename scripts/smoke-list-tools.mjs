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
const agentSnapshotPath = resolve(root, 'scripts/fixtures/tools-schema.agent.snapshot.json');
const AGENT_LOOP_TOOLS = ['ruyi_observe', 'ruyi_act'];
const AGENT_REQUIRED_TOOLS = [
  'ruyi_new_page',
  'ruyi_attach_browser',
  'ruyi_navigate_page',
  'ruyi_observe',
  'ruyi_act',
  'ruyi_browser_quit',
  'ruyi_browser_status',
  'ruyi_export_session',
  'ruyi_handle_cloudflare',
];
const EXPERT_ONLY_TOOLS = [
  'ruyi_break_on_xhr',
  'ruyi_debug_disable',
  'ruyi_debug_enable',
  'ruyi_debug_expand_object',
  'ruyi_debug_get_frames',
  'ruyi_debug_get_paused_info',
  'ruyi_debug_get_scopes',
  'ruyi_debug_list_sources',
  'ruyi_debug_pause',
  'ruyi_debug_pause_on_exception',
  'ruyi_debug_resume',
  'ruyi_debug_set_breakpoint',
  'ruyi_debug_status',
  'ruyi_debug_step',
  'ruyi_debug_wait_paused',
  'ruyi_get_script_source',
  'ruyi_list_breakpoints',
  'ruyi_list_preload_scripts',
  'ruyi_list_scripts',
  'ruyi_remove_breakpoint',
  'ruyi_save_script_source',
  'ruyi_search_in_sources',
  'ruyi_set_breakpoint_on_text',
];

async function listTools(toolset) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'build/src/index.js')],
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, RUYI_MCP_TOOLSET: toolset },
  });
  let serverStderr = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', (chunk) => {
    serverStderr += chunk;
  });
  const client = new Client({ name: 'ruyi-mcp-smoke', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return { result, serverStderr };
  } finally {
    await client.close();
  }
}

function assertControlPlaneLogs(serverStderr) {
  assert.match(
    serverStderr,
    /\[ruyi-mcp\] Evidence handoff: browser-session-handoff\.v1/,
    'startup log must identify the canonical evidence handoff contract'
  );
  assert.match(
    serverStderr,
    /firefox-debugger/,
    'startup log must advertise the native Firefox debugger plane'
  );
  assert.match(
    serverStderr,
    /Debugger observations are not RuyiTrace browser facts/,
    'startup log must refuse to equate debugger observations with RuyiTrace'
  );
  assert.doesNotMatch(
    serverStderr,
    /\[ruyi-mcp\] Trace:/,
    'control-plane startup log must not claim Trace capability'
  );
}

const compactListed = await listTools('compact');
assert.deepEqual(compactListed.result.tools.map((tool) => tool.name).sort(), [
  'ruyi_act', 'ruyi_browser_status', 'ruyi_execute_tool', 'ruyi_observe', 'ruyi_search_tools',
]);

const automation = await listTools('automation');
assertControlPlaneLogs(automation.serverStderr);
assert.match(automation.serverStderr, /\[ruyi-mcp\] Toolset: automation/);
const automationNames = automation.result.tools.map((tool) => tool.name);
if (new Set(automationNames).size !== automationNames.length) {
  throw new Error('automation tools/list contains duplicate tool names');
}
for (const name of EXPERT_ONLY_TOOLS) {
  if (automationNames.includes(name)) {
    throw new Error(`${name} must stay off the default automation toolset`);
  }
}
for (const required of ['ruyi_new_page', 'ruyi_human_click', 'ruyi_export_session', 'ruyi_browser_quit']) {
  if (!automationNames.includes(required)) {
    throw new Error(`${required} must remain on the automation toolset`);
  }
}
for (const name of AGENT_LOOP_TOOLS) {
  if (automationNames.includes(name)) {
    throw new Error(`${name} must stay off the default automation toolset until P4`);
  }
}

const debugListed = await listTools('debug');
assertControlPlaneLogs(debugListed.serverStderr);
assert.match(debugListed.serverStderr, /\[ruyi-mcp\] Toolset: debug/);
const debugNames = debugListed.result.tools.map((tool) => tool.name);
for (const name of EXPERT_ONLY_TOOLS) {
  if (!debugNames.includes(name)) {
    throw new Error(`${name} must be available in RUYI_MCP_TOOLSET=debug`);
  }
}
for (const name of AGENT_LOOP_TOOLS) {
  if (debugNames.includes(name)) {
    throw new Error(`${name} must stay off the debug toolset in P0`);
  }
}

const listed = await listTools('all');
assertControlPlaneLogs(listed.serverStderr);
assert.match(listed.serverStderr, /\[ruyi-mcp\] Toolset: all/);
const result = listed.result;
for (const name of ['ruyi_bidi_trace_start', 'ruyi_bidi_trace_stop', 'ruyi_bidi_trace_get_results', 'ruyi_trace_start', 'ruyi_trace_stop', 'ruyi_trace_get_results']) {
  assert.ok(result.tools.some((tool) => tool.name === name), `${name} must remain callable`);
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
const newPage = result.tools.find((tool) => tool.name === 'ruyi_new_page');
if (!newPage?.inputSchema?.properties?.fingerprint?.properties?.firefoxVersion) {
  throw new Error('ruyi_new_page.fingerprint.firefoxVersion is not exposed');
}
const selectFrame = result.tools.find((tool) => tool.name === 'ruyi_select_frame');
if (!selectFrame?.inputSchema?.properties?.selector) {
  throw new Error('ruyi_select_frame.selector is not exposed');
}
const exportSession = result.tools.find((tool) => tool.name === 'ruyi_export_session');
const exportRequired = exportSession?.inputSchema?.required ?? [];
if (!exportRequired.includes('caseId') || !exportRequired.includes('workspaceRoot')) {
  throw new Error('ruyi_export_session must require canonical caseId and workspaceRoot inputs');
}
if (exportSession?.inputSchema?.properties?.outputFile) {
  throw new Error('ruyi_export_session legacy outputFile contract must remain retired');
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
for (const name of EXPERT_ONLY_TOOLS) {
  if (!names.includes(name)) {
    throw new Error(`${name} must remain available in RUYI_MCP_TOOLSET=all`);
  }
}
for (const name of AGENT_LOOP_TOOLS) {
  assert.ok(names.includes(name), `${name} must be included in the complete toolset`);
}

const agentListed = await listTools('agent');
assertControlPlaneLogs(agentListed.serverStderr);
assert.match(agentListed.serverStderr, /\[ruyi-mcp\] Toolset: agent/);
const agentNames = agentListed.result.tools.map((tool) => tool.name);
if (new Set(agentNames).size !== agentNames.length) {
  throw new Error('agent tools/list contains duplicate tool names');
}
for (const name of AGENT_REQUIRED_TOOLS) {
  if (!agentNames.includes(name)) {
    throw new Error(`${name} must be available in RUYI_MCP_TOOLSET=agent`);
  }
}
for (const name of EXPERT_ONLY_TOOLS) {
  if (agentNames.includes(name)) {
    throw new Error(`${name} must stay off the agent toolset`);
  }
}
if (agentNames.includes('ruyi_human_click')) {
  throw new Error('ruyi_human_click belongs to automation, not the P0 agent surface');
}
const agentSnapshot = canonicalize({
  snapshotVersion: 1,
  tools: [...agentListed.result.tools].sort((left, right) => compareAscii(left.name, right.name)),
});
const agentSnapshotText = serializeSnapshot(agentSnapshot);

const snapshot = canonicalize({
  snapshotVersion: 1,
  tools: [...result.tools].sort((left, right) => compareAscii(left.name, right.name)),
});
const snapshotText = serializeSnapshot(snapshot);

if (updateSnapshot) {
  await updateSnapshotAtomically(snapshotPath, snapshotText);
  await updateSnapshotAtomically(agentSnapshotPath, agentSnapshotText);
  console.log(`ruyi-mcp schema snapshot updated: ${snapshotPath}`);
  console.log(`ruyi-mcp agent schema snapshot updated: ${agentSnapshotPath}`);
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

  let expectedAgentText;
  try {
    expectedAgentText = await readFile(agentSnapshotPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to read agent tool schema snapshot (${message}). `
        + 'Run npm run snapshot:tools to create it explicitly.'
    );
  }
  const expectedAgent = JSON.parse(expectedAgentText);
  const canonicalExpectedAgentText = serializeSnapshot(canonicalize(expectedAgent));
  if (expectedAgentText !== canonicalExpectedAgentText) {
    throw new Error(
      'Agent tool schema snapshot is not canonical. Run npm run snapshot:tools to rewrite it explicitly.'
    );
  }
  assert.deepStrictEqual(
    agentSnapshot,
    expectedAgent,
    'Agent tool schema snapshot changed. Review the contract and run npm run snapshot:tools explicitly.'
  );
}

console.log(
  `ruyi-mcp smoke OK: automation ${automation.result.tools.length} tools, debug ${debugListed.result.tools.length} tools, all ${result.tools.length} tools, agent ${agentListed.result.tools.length} tools`
);
