import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveGateFirefox } from './runtime-firefox.mjs';

test('runtime gates require an explicit absolute executable path', async () => {
  await assert.rejects(resolveGateFirefox(''), /Set RUYI_FIREFOX_PATH/);
  await assert.rejects(resolveGateFirefox('firefox'), /absolute path/);
  assert.equal(await resolveGateFirefox(process.execPath), process.execPath);

  const fixture = await mkdtemp(join(tmpdir(), 'ruyi-mcp-runtime-'));
  try {
    await assert.rejects(resolveGateFirefox(fixture), /not a regular file/);
    await assert.rejects(resolveGateFirefox(join(fixture, 'missing-firefox')), /ENOENT/);
    if (process.platform !== 'win32') {
      const noExecute = join(fixture, 'not executable');
      await writeFile(noExecute, '', { mode: 0o644 });
      await assert.rejects(resolveGateFirefox(noExecute), /EACCES/);
    }
  } finally {
    await rm(fixture, { recursive: true });
  }
});
