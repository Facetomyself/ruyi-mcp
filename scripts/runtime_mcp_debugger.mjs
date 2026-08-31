#!/usr/bin/env node

/**
 * End-to-end MCP debugger gate.
 *
 * Unlike runtime_debugger.py, this script exercises the complete production
 * path: Node MCP server -> Python JSON-RPC bridge -> Firefox BiDi + RDP.
 */

import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodeExe = process.env.RUYI_MCP_NODE || process.execPath;
const pythonExe = process.env.RUYI_MCP_PYTHON || process.env.PYTHON || 'python';
const firefoxPath = process.env.RUYI_FIREFOX_PATH
  || resolve(root, '..', '..', 'tools', 'ruyipage', 'runtimes', '151-proxy', 'firefox', 'firefox.exe');
const configuredProfileRoot = process.env.RUYI_MCP_PROFILE_ROOT;
const profileRoot = configuredProfileRoot
  || join(root, '..', '..', 'temp', `ruyi-mcp-debug-profiles-${process.pid}`);
const ownsProfileRoot = !configuredProfileRoot;
const evidenceRoot = process.env.RUYI_MCP_DEBUG_EVIDENCE_ROOT
  || join(root, '..', '..', 'temp', `ruyi-mcp-debug-evidence-${process.pid}`);
const runId = `debug_${Date.now()}_${process.pid}`;

const html = '<!doctype html><html><head><title>debug gate</title></head>'
  + '<body><script src="/app.js"></script></body></html>';
const appJs = [
  'function targetFn(x) {',
  '  var y = x + 1;',
  '  return y * 2;',
  '}',
  'async function xhrFn() {',
  "  const response = await fetch('/api/data', { method: 'GET', cache: 'no-store' });",
  '  return await response.text();',
  '}',
  'eval("function evalTarget(x) {\\n  var evalValue = x + 2;\\n  return evalValue;\\n}");',
  '',
].join('\n');

function parseText(result, label) {
  assert.ok(result?.content?.[0]?.text, `${label} returned no text content`);
  return JSON.parse(result.content[0].text);
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${milliseconds}ms`));
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const server = createHttpServer((request, response) => {
  let body;
  let contentType;
  if (request.url === '/app.js') {
    body = appJs;
    contentType = 'application/javascript; charset=utf-8';
  } else if (request.url === '/api/data') {
    body = 'xhr-ok';
    contentType = 'text/plain; charset=utf-8';
  } else {
    body = html;
    contentType = 'text/html; charset=utf-8';
  }
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
});

await mkdir(profileRoot, { recursive: true });
await mkdir(evidenceRoot, { recursive: true });
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const targetUrl = `http://127.0.0.1:${server.address().port}/`;

const transport = new StdioClientTransport({
  command: nodeExe,
  args: [join(root, 'build', 'src', 'index.js')],
  cwd: root,
  stderr: 'pipe',
  env: {
    ...process.env,
    RUYI_MCP_TOOLSET: 'debug',
    RUYI_MCP_PYTHON: pythonExe,
    RUYI_FIREFOX_PATH: firefoxPath,
    RUYI_MCP_PROFILE_ROOT: profileRoot,
  },
});
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr += chunk.toString();
});
const client = new Client(
  { name: 'ruyi-mcp-debug-runtime-gate', version: '1.0.0' },
  { capabilities: {} },
);
const call = (name, args, timeout = 20_000) => withTimeout(
  client.callTool({ name, arguments: args }),
  timeout,
  name,
);

let quitSent = false;
try {
  await client.connect(transport);

  const created = parseText(await call('ruyi_new_page', {
    url: targetUrl,
    headless: true,
    enableDebugger: true,
    debuggerAutoResumeAfter: 20,
    debugEvidenceRoot: evidenceRoot,
    debugCaseId: 'ruyi-debug-runtime',
    debugRunId: runId,
  }, 40_000), 'ruyi_new_page');
  assert.equal(created.launched, true);
  assert.equal(created.debugger.started, true, 'debugger must attach after first navigation');

  const status = parseText(await call('ruyi_debug_status'), 'ruyi_debug_status');
  assert.equal(status.started, true);
  assert.equal(status.port > 0, true);

  const sources = parseText(
    await call('ruyi_debug_list_sources', { urlContains: 'app.js' }),
    'ruyi_debug_list_sources',
  );
  const source = sources.sources.find((item) => item.url.endsWith('/app.js'));
  assert.ok(source?.sourceActor, 'app.js source actor missing');

  const sourceText = parseText(
    await call('ruyi_get_script_source', {
      url: source.url,
      offset: appJs.indexOf('var y'),
      length: 7,
    }),
    'ruyi_get_script_source',
  );
  assert.equal(sourceText.source, 'var y =');

  const allSources = parseText(
    await call('ruyi_debug_list_sources'),
    'ruyi_debug_list_sources(all)',
  );
  let evalSource;
  let evalSourceText;
  for (const candidate of allSources.sources) {
    if (!candidate.sourceActor) continue;
    try {
      const candidateText = parseText(
        await call('ruyi_get_script_source', { sourceActor: candidate.sourceActor }),
        'ruyi_get_script_source(candidate)',
      );
      if (
        candidate.introductionType === 'eval'
        && typeof candidateText.source === 'string'
        && /^function evalTarget\b/.test(candidateText.source.trim())
      ) {
        evalSource = candidate;
        evalSourceText = candidateText;
        break;
      }
    } catch {
      // Internal bootstrap/eval sources may disappear between source snapshots.
    }
  }
  assert.ok(evalSource?.sourceActor, 'eval/blob source actor missing');
  assert.ok(evalSourceText, 'eval/blob source text missing');
  assert.match(evalSourceText.source, /evalTarget/);

  const evalLines = evalSourceText.source.split('\n');
  const evalLine = evalLines.findIndex((line) => line.includes('evalValue')) + 1;
  assert.ok(evalLine > 0, 'eval source breakpoint line missing');
  const evalBreakpoint = parseText(
    await call('ruyi_debug_set_breakpoint', {
      sourceActor: evalSource.sourceActor,
      line: evalLine,
    }),
    'ruyi_debug_set_breakpoint(eval)',
  );
  assert.equal(evalBreakpoint.sourceActor, evalSource.sourceActor);
  const evalTriggerPromise = call('ruyi_evaluate_script', {
    function: 'return evalTarget(40)',
    timeout: 30,
  }, 40_000);
  const evalPaused = parseText(
    await call('ruyi_debug_wait_paused', { timeout: 15 }, 20_000),
    'ruyi_debug_wait_paused(eval)',
  );
  assert.equal(evalPaused.paused, true);
  await call('ruyi_debug_resume');
  const evalTrigger = parseText(await evalTriggerPromise, 'ruyi_evaluate_script(eval)');
  assert.equal(evalTrigger.result, 42);
  await call('ruyi_remove_breakpoint', { breakpointId: evalBreakpoint.breakpointId });

  const breakpoint = parseText(
    await call('ruyi_debug_set_breakpoint', {
      url: source.url,
      line: 2,
    }),
    'ruyi_debug_set_breakpoint',
  );
  assert.equal(breakpoint.type, 'native');
  assert.equal(breakpoint.pageIdx, 0);

  // The trigger and wait are intentionally concurrent. A synchronous Python
  // bridge would deadlock this pair until the wait timeout.
  const triggerPromise = call('ruyi_evaluate_script', {
    function: 'return targetFn(41)',
    timeout: 30,
  }, 40_000);
  const paused = parseText(
    await call('ruyi_debug_wait_paused', { timeout: 15 }, 20_000),
    'ruyi_debug_wait_paused',
  );
  assert.equal(paused.paused, true);
  assert.equal(paused.state.line, 2);

  const scope = parseText(await call('ruyi_debug_get_scopes'), 'ruyi_debug_get_scopes');
  assert.equal(scope.scope.x, 41);

  await call('ruyi_debug_step', { type: 'over' });
  const stepped = parseText(
    await call('ruyi_debug_wait_paused', { timeout: 10 }, 15_000),
    'ruyi_debug_wait_paused(step)',
  );
  assert.equal(stepped.paused, true);
  await call('ruyi_debug_resume');
  const trigger = parseText(await triggerPromise, 'ruyi_evaluate_script');
  assert.equal(trigger.result, 84);

  const listed = parseText(await call('ruyi_list_breakpoints'), 'ruyi_list_breakpoints');
  assert.equal(listed.breakpoints.length, 1);
  await call('ruyi_remove_breakpoint', { breakpointId: breakpoint.breakpointId });
  const afterRemove = parseText(await call('ruyi_list_breakpoints'), 'ruyi_list_breakpoints(remove)');
  assert.equal(afterRemove.breakpoints.length, 0);

  // ruyiPage 1.2.68 exposes the Firefox RDP request-level XHR breakpoint.
  // Verify the MCP path pauses on the request itself, rather than silently
  // falling back to a source-text heuristic.
  const xhrBreakpoint = parseText(
    await call('ruyi_break_on_xhr', { url: '/api/data', method: 'GET' }),
    'ruyi_break_on_xhr',
  );
  assert.equal(xhrBreakpoint.ok, true);
  assert.equal(xhrBreakpoint.heuristic, false);
  assert.equal(xhrBreakpoint.verifiedRequestBreakpoint, true);
  assert.equal(xhrBreakpoint.method, 'GET');
  assert.equal(xhrBreakpoint.breakpoints.length, 1);

  const xhrTriggerPromise = call('ruyi_evaluate_script', {
    function: 'return xhrFn()',
    timeout: 30,
  }, 40_000);
  const xhrPaused = parseText(
    await call('ruyi_debug_wait_paused', { timeout: 15 }, 20_000),
    'ruyi_debug_wait_paused(xhr)',
  );
  assert.equal(xhrPaused.paused, true);
  assert.equal(xhrPaused.state.why, 'XHR');
  await call('ruyi_debug_resume');
  const xhrTrigger = parseText(await xhrTriggerPromise, 'ruyi_evaluate_script(xhr)');
  assert.equal(xhrTrigger.result, 'xhr-ok');

  const xhrBreakpointId = xhrBreakpoint.breakpoints[0].breakpointId;
  await call('ruyi_remove_breakpoint', { breakpointId: xhrBreakpointId });
  const afterXhrRemove = parseText(
    await call('ruyi_list_breakpoints'),
    'ruyi_list_breakpoints(xhr-remove)',
  );
  assert.equal(afterXhrRemove.breakpoints.length, 0);

  // Non-finite JS values must remain valid JSON on the Python bridge wire.
  const nonFinite = parseText(
    await call('ruyi_evaluate_script', {
      function: 'return ({ nan: NaN, positive: Infinity, negative: -Infinity })',
    }),
    'ruyi_evaluate_script(non-finite)',
  );
  assert.deepEqual(nonFinite.result, {
    nan: 'NaN',
    positive: 'Infinity',
    negative: '-Infinity',
  });

  // A second tab gets its own debugger/thread and breakpoint registry entry.
  // Removing it through page 0 must fail closed instead of silently deleting
  // the wrong native breakpoint.
  const secondPage = parseText(
    await call('ruyi_new_page', { url: `${targetUrl}second` }, 40_000),
    'ruyi_new_page(second)',
  );
  assert.equal(secondPage.launched, false);
  assert.equal(secondPage.pageIdx, 1);
  const secondSources = parseText(
    await call('ruyi_debug_list_sources', { pageIdx: 1, urlContains: 'app.js' }),
    'ruyi_debug_list_sources(second)',
  );
  const secondSource = secondSources.sources.find((item) => item.url.endsWith('/app.js'));
  assert.ok(secondSource?.sourceActor, 'second-page source actor missing');
  const secondBreakpoint = parseText(
    await call('ruyi_debug_set_breakpoint', {
      pageIdx: 1,
      url: secondSource.url,
      line: 2,
    }),
    'ruyi_debug_set_breakpoint(second)',
  );
  assert.equal(secondBreakpoint.pageIdx, 1);
  let wrongPageError = '';
  try {
    const wrongPageResult = await call('ruyi_remove_breakpoint', {
      pageIdx: 0,
      breakpointId: secondBreakpoint.breakpointId,
    });
    wrongPageError = String(wrongPageResult?.content?.[0]?.text || '');
    assert.equal(wrongPageResult.isError, true);
  } catch (error) {
    wrongPageError = String(error);
  }
  assert.match(wrongPageError, /belongs to pageIdx 1/);
  const secondListed = parseText(
    await call('ruyi_list_breakpoints', { pageIdx: 1 }),
    'ruyi_list_breakpoints(second)',
  );
  assert.equal(secondListed.breakpoints.length, 1);
  await call('ruyi_remove_breakpoint', { breakpointId: secondBreakpoint.breakpointId });
  const secondAfterRemove = parseText(
    await call('ruyi_list_breakpoints', { pageIdx: 1 }),
    'ruyi_list_breakpoints(second-remove)',
  );
  assert.equal(secondAfterRemove.breakpoints.length, 0);

  const disabled = parseText(await call('ruyi_debug_disable'), 'ruyi_debug_disable');
  assert.equal(disabled.started, false);
  assert.equal(disabled.breakpointCount, 0);
  const disabledStatus = parseText(
    await call('ruyi_debug_status', { pageIdx: 0 }),
    'ruyi_debug_status(disabled)',
  );
  assert.equal(disabledStatus.started, false);
  assert.equal(disabledStatus.breakpointCount, 0);
  const reenabled = parseText(
    await call('ruyi_debug_enable', { pageIdx: 0, autoResumeAfter: 0 }),
    'ruyi_debug_enable(re-enable)',
  );
  assert.equal(reenabled.started, true);
  const reenabledStatus = parseText(
    await call('ruyi_debug_status', { pageIdx: 0 }),
    'ruyi_debug_status(re-enabled)',
  );
  assert.equal(reenabledStatus.started, true);
  assert.equal(reenabledStatus.breakpointCount, 0);
  const postDisableTriggerPromise = call('ruyi_evaluate_script', {
    pageIdx: 0,
    function: 'return xhrFn()',
    timeout: 30,
  }, 40_000);
  const postDisableWait = parseText(
    await call('ruyi_debug_wait_paused', { pageIdx: 0, timeout: 1 }, 5_000),
    'ruyi_debug_wait_paused(after-disable)',
  );
  assert.equal(postDisableWait.paused, false);
  const postDisableTrigger = parseText(
    await postDisableTriggerPromise,
    'ruyi_evaluate_script(after-disable)',
  );
  assert.equal(postDisableTrigger.result, 'xhr-ok');

  // A later navigation must not leave the already-connected RDP thread stale.
  const renavigated = parseText(
    await call('ruyi_navigate_page', { pageIdx: 0, url: targetUrl }, 40_000),
    'ruyi_navigate_page(reload)',
  );
  assert.equal(renavigated.navigated, true);
  const postNavigationSources = parseText(
    await call('ruyi_debug_list_sources', { pageIdx: 0, urlContains: 'app.js' }),
    'ruyi_debug_list_sources(post-navigation)',
  );
  assert.ok(
    postNavigationSources.sources.some((item) => item.url.endsWith('/app.js')),
    'debugger sources unavailable after a later navigation',
  );

  const evidence = status.evidence || paused.evidence || scope.evidence;
  assert.ok(evidence, 'debug evidence pointer missing');
  assert.equal(evidence.plane, 'ruyi-debug');
  assert.match(evidence.path, /^evidence\/web\/ruyi-debug\//);
  const evidenceText = await readFile(join(evidenceRoot, ...evidence.path.split('/')), 'utf8');
  assert.ok(evidenceText.trim().length > 0, 'debug evidence file is empty');
  assert.doesNotMatch(evidenceText, /Bearer\s+[A-Za-z0-9._-]+/i);
  await call('ruyi_debug_disable');
  await call('ruyi_browser_quit');
  quitSent = true;

  console.log(JSON.stringify({
    ok: true,
    targetUrl,
    debuggerPort: status.port,
    breakpoint: { line: breakpoint.line, column: breakpoint.column },
    paused: { why: paused.state.why, line: paused.state.line },
    scopeX: scope.scope.x,
    triggerResult: trigger.result,
    xhrPaused: { why: xhrPaused.state.why },
    xhrTriggerResult: xhrTrigger.result,
    evalSourceActor: evalSource.sourceActor,
    secondPageIdx: secondPage.pageIdx,
    nonFinite: nonFinite.result,
    evidencePath: evidence.path,
    stderrTail: stderr.slice(-1000),
  }, null, 2));
} finally {
  if (!quitSent) {
    try { await call('ruyi_debug_resume', {}, 5_000); } catch {}
    try { await call('ruyi_browser_quit', {}, 10_000); } catch {}
  }
  try { await client.close(); } catch {}
  server.close();
  if (!process.env.RUYI_MCP_DEBUG_EVIDENCE_ROOT) {
    await rm(evidenceRoot, { recursive: true, force: true }).catch(() => {});
  }
  if (ownsProfileRoot) {
    await rm(profileRoot, { recursive: true, force: true }).catch(() => {});
  }
}
