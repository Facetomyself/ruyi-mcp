import { createInterface } from 'node:readline';

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

process.stdout.on('error', () => {
  process.exit(0);
});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);

  if (request.method === '__shutdown__') {
    respond(request.id, { shutdown: true });
    setImmediate(() => process.exit(0));
    return;
  }

  if (request.method.startsWith('fixture.hang')) {
    return;
  }

  if (request.id !== null && request.id !== undefined) {
    respond(request.id, request.method === 'browser.status'
      ? { alive: false, fixture: true }
      : { ok: true, method: request.method });
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

process.stderr.write('[ruyi_bridge] Ready\n');
