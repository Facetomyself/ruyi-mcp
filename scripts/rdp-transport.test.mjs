import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';
import { NativeDebuggerManager } from '../build/src/rdp/index.js';
import { RdpTransport } from '../build/src/rdp/transport.js';

const encode = packet => { const body = Buffer.from(JSON.stringify(packet)); return Buffer.concat([Buffer.from(`${body.length}:`), body]); };
async function server(handler) {
  const sockets = new Set();
  const instance = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write(encode({ from: 'root', applicationType: 'browser', traits: {} }));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.includes(58)) {
        const separator = buffer.indexOf(58);
        const length = Number(buffer.subarray(0, separator));
        if (buffer.length < separator + 1 + length) break;
        const packet = JSON.parse(buffer.subarray(separator + 1, separator + 1 + length));
        buffer = buffer.subarray(separator + 1 + length);
        handler(packet, response => socket.write(encode(response)), socket);
      }
    });
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { port: instance.address().port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => instance.close(resolve)); } };
}

test('actor FIFO, events and UTF8 fragmented frames remain distinct', async () => {
  const order = [];
  const fixture = await server((packet, send) => {
    order.push(packet.type);
    send({ from: packet.to, type: 'paused', why: { type: 'breakpoint' } });
    setTimeout(() => send({ from: packet.to, type: 'function', value: packet.type + '中文' }), 5);
  });
  const transport = new RdpTransport();
  try {
    await transport.open('127.0.0.1', fixture.port);
    let events = 0;
    transport.on('event', () => events++);
    const replies = await Promise.all([transport.request('thread', 'first'), transport.request('thread', 'second')]);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(replies[0].value, 'first中文');
    assert.equal(replies[1].value, 'second中文');
    assert.equal(events, 2);
  } finally { transport.close(); await fixture.close(); }
});

test('forwarding cancellation cannot consume the pending root getTab reply', async () => {
  const tab = { actor: 'descriptor', browserId: 9, browsingContextID: 10 };
  const retirement = { from: 'root', type: 'forwardingCancelled', prefix: 'process5' };
  const fixture = await server((packet, send) => {
    assert.equal(packet.type, 'getTab');
    send(retirement);
    send({ from: 'root', tab });
  });
  const transport = new RdpTransport();
  try {
    await transport.open('127.0.0.1', fixture.port);
    const events = [];
    transport.on('event', event => events.push(event));
    assert.deepEqual(await transport.request('root', 'getTab', { browserId: 9 }), { from: 'root', tab });
    assert.deepEqual(events, [retirement]);
  } finally { transport.close(); await fixture.close(); }
});

test('timeout destroys epoch and cannot consume a late reply', async () => {
  const fixture = await server(() => {});
  const transport = new RdpTransport();
  try {
    await transport.open('127.0.0.1', fixture.port);
    await assert.rejects(transport.request('thread', 'frames', {}, 20), error => error.code === 'RDP_TIMEOUT');
    assert.equal(transport.connected, false);
    await assert.rejects(transport.request('thread', 'resume'), error => error.code === 'RDP_TIMEOUT');
  } finally { transport.close(); await fixture.close(); }
});

test('disconnect rejects concurrent actors', async () => {
  const fixture = await server((_packet, _send, socket) => socket.destroy());
  const transport = new RdpTransport();
  try {
    await transport.open('127.0.0.1', fixture.port);
    const results = await Promise.allSettled([transport.request('one', 'frames'), transport.request('two', 'source')]);
    assert.ok(results.every(result => result.status === 'rejected'));
  } finally { transport.close(); await fixture.close(); }
});

test('native owner IPC correlates replies before accepting lease state', async () => {
  const seen = [];
  const owner = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body.requestId);
    const packet = seen.length === 1 ? { requestId: body.requestId, ok: true, result: { accepting: true } } :
      seen.length === 2 ? { requestId: seen[0], ok: true, result: { leaseId: 'stale' } } :
      { requestId: body.requestId, ok: false, error: { code: 'LEASE_BUSY', message: 'Lease already in use' } };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(packet));
  });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  const descriptor = { port: 1, lease: { endpoint: `http://127.0.0.1:${owner.address().port}`, target: 'bidi-context' } };
  const manager = new NativeDebuggerManager(async () => descriptor);
  try {
    await manager.configure(descriptor);
    assert.deepEqual(await manager.lease('status'), { accepting: true });
    await assert.rejects(manager.attach(), { code: 'LEASE_RESPONSE_MISMATCH' });
    await assert.rejects(manager.attach(), { code: 'LEASE_BUSY' });
    assert.equal(new Set(seen).size, 3);
  } finally {
    await manager.close();
    owner.closeAllConnections();
    await new Promise(resolve => owner.close(resolve));
  }
});

for (const resumeFails of [false, true]) {
  test(`native close resumes nested pauses by event order (${resumeFails ? 'resume fails' : 'resume succeeds'})`, async () => {
    const operations = [];
    const fixture = await server((packet, send) => {
      operations.push(`${packet.to}:${packet.type}`);
      if (resumeFails && packet.to === 'first') send({ from: packet.to, error: 'wrongOrder' });
      else send({ from: packet.to });
    });
    const transport = new RdpTransport();
    const manager = new NativeDebuggerManager(async () => null);
    try {
      await transport.open('127.0.0.1', fixture.port);
      transport.on('closed', () => operations.push('transport:closed'));
      manager.transport = transport;
      manager.mode = 'armed';
      manager.ownsLease = true;
      manager.lease = async (action, args) => { operations.push([action, args]); };
      for (const thread of ['first', 'second']) {
        manager.targets.set(thread, { id: thread, thread, grips: new Map() });
      }
      manager.handleEvent({ from: 'second', type: 'paused' });
      manager.handleEvent({ from: 'first', type: 'paused' });
      assert.deepEqual(operations.splice(0), [['lease.pause', { paused: true }], ['lease.pause', { paused: true }]]);
      await manager.close();
      assert.deepEqual(operations, [
        'first:resume', 'second:resume', 'transport:closed', ['lease.release', { resumed: !resumeFails }],
      ]);
    } finally { await manager.close(); transport.close(); await fixture.close(); }
  });
}
