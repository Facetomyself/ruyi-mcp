import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DebugEvidence } from '../build/src/debug-evidence.js';

test('native debugger evidence stores only bounded metadata and hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ruyi-evidence-'));
  try {
    const evidence = new DebugEvidence();
    evidence.configure({ debugEvidenceRoot: root, debugCaseId: 'fixture-case', debugRunId: 'fixture-run' });
    const pointer = evidence.record('debug.scope', { secret: 'not-for-evidence', source: 'private source body', pauseId: 'pause-1', scope: { value: 'hidden' } });
    const bytes = await readFile(join(root, pointer.path));
    assert.equal(pointer.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(pointer.bytes, bytes.length);
    assert.doesNotMatch(bytes.toString('utf8'), /not-for-evidence|private source body|hidden/);
    assert.equal(JSON.parse(bytes.toString('utf8')).payload.pauseId, 'pause-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
