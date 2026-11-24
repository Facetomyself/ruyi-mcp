import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
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
