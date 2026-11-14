import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BorrowedTraceSession } from '../build/src/borrowed-session.js';

test('borrowed session uses owner lease and never exposes descriptor token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ruyi-borrowed-contract-'));
  const calls = [];
  const owner = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    calls.push(body);
    assert.equal(body.token, descriptor.control.token);
    let result = { accepting: true, phase: 'capturing', runId: descriptor.runId, target: descriptor.bidi.contextId, browser: descriptor.browser, runtime: descriptor.runtime };
    if (body.action === 'lease.acquire') result = { leaseId: 'fixture-lease' };
    if (body.action === 'query') result = { count: 1, elements: [{ tag: 'button', text: 'Go', selector: 'html>body>button:nth-of-type(1)', visible: true }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ requestId: body.requestId, ok: true, result }));
  });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  const sessionPath = join(directory, 'session.json');
  const descriptor = {
    schema: 'ruyitrace-live-session.v1', runId: 'fixture-run', phase: 'capturing', runtime: { version: '159', buildId: '20261101193257', binarySha256: 'a'.repeat(64) },
    browser: { pid: process.pid, creationTime: 'fixture-creation', executablePath: process.execPath }, bidi: { contextId: 'fixture-context' }, rdp: null,
    control: { endpoint: `http://127.0.0.1:${owner.address().port}`, token: 'fixture-token-1234567890' },
  };
  await writeFile(sessionPath, JSON.stringify(descriptor), 'utf8');
  try {
    const session = await BorrowedTraceSession.attach(sessionPath);
    assert.equal(JSON.stringify(await session.status()).includes(descriptor.control.token), false);
    const snapshot = await session.observe();
    await session.act({ op: 'CLICK', snapshotId: snapshot.snapshotId, index: 0 });
    const click = calls.find(call => call.action === 'click');
    assert.equal(click.leaseId, 'fixture-lease');
    assert.equal(click.target, 'fixture-context');
    await session.release();
    assert.ok(calls.some(call => call.action === 'lease.release'));
    assert.ok(calls.every(call => !['quit', 'close', 'session.new'].includes(call.action)));
    await writeFile(sessionPath, JSON.stringify({ ...descriptor, browser: { ...descriptor.browser, pid: 1 } }), 'utf8');
    await assert.rejects(session.currentDescriptor(), /identity changed/);
  } finally {
    owner.closeAllConnections();
    await new Promise(resolve => owner.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
