import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const [image, mode = 'core', ...option] = process.argv.slice(2);
assert.ok(image && !image.startsWith('-') && ['core', 'browser'].includes(mode)
  && (option.length === 0 || (mode === 'browser' && option.length === 1 && option[0].startsWith('/'))),
'Usage: node scripts/container-smoke.mjs IMAGE [core|browser [/absolute/firefox-directory]]');

function docker(...args) {
  return execFileSync('docker', args, { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function check(stop) {
  const name = `ruyi-mcp-smoke-${randomUUID()}`;
  const args = ['run', '--name', name, '--rm', '-i', '--init', '--network=none',
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--shm-size=256m', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
    '-e', `RUYI_MCP_TOOLSET=${mode === 'browser' ? 'automation' : 'compact'}`];
  if (option.length) args.push('--mount', `type=bind,src=${option[0]},dst=/opt/firefox,readonly`);
  const child = spawn('docker', [...args, image], { stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32_768); });
  child.stdin.on('error', () => {});
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 90_000);
  let id = 0;
  function send(message) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  async function call(method, params) {
    const requestId = ++id;
    send({ id: requestId, method, params });
    while (true) {
      const { value, done } = await lines.next();
      assert.ok(!done, `container closed while waiting for ${method}`);
      const response = JSON.parse(value);
      assert.equal(response.jsonrpc, '2.0');
      if (response.id === undefined) continue;
      assert.equal(response.id, requestId);
      assert.ok(!response.error, JSON.stringify(response.error));
      return response.result;
    }
  }
  async function tool(name, args = {}) {
    const result = await call('tools/call', { name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content[0].text);
  }
  try {
    const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'ruyi-container-smoke', version: '1.0.0' } });
    assert.equal(initialized.serverInfo.name, 'ruyi-mcp');
    send({ method: 'notifications/initialized' });
    const tools = await call('tools/list');
    assert.ok(tools.tools.some(entry => entry.name === 'ruyi_browser_status'));
    assert.deepEqual(await tool('ruyi_browser_status'), { alive: false });
    assert.equal(docker('exec', name, 'id', '-u'), '10001');
    if (mode === 'browser') {
      const url = 'data:text/html,<title>ruyi-container-fixture</title><p>local</p>';
      const page = await tool('ruyi_new_page', { url, headless: true, enableDebugger: false, timeout: 15 });
      assert.equal(page.launched, true);
      assert.equal(page.title, 'ruyi-container-fixture');
      const status = await tool('ruyi_browser_status');
      assert.equal(status.alive, true);
      assert.ok(Number.isInteger(status.browserPid) && status.browserPid > 0);
      await tool('ruyi_browser_quit');
      assert.deepEqual(await tool('ruyi_browser_status'), { alive: false });
    }
    if (stop === 'EOF') child.stdin.end();
    else docker('kill', '--signal=TERM', name);
    for await (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    assert.deepEqual(await exit, { code: 0, signal: null });
    assert.match(stderr, /Python bridge ready/);
    assert.equal(stderr.match(/Server closing, cleaning up/g)?.length, 1);
    assert.match(stderr, stop === 'EOF' ? /stdin EOF received|MCP transport closed received/ : /SIGTERM received/);
    console.log(`${mode} container smoke passed (${stop})`);
  } catch (error) {
    console.error(stderr);
    throw error;
  } finally {
    clearTimeout(watchdog);
    reader.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { docker('rm', '-f', name); } catch { /* removed by --rm */ }
  }
}

await check('EOF');
if (mode === 'core') await check('SIGTERM');
