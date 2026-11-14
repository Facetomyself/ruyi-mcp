import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceMaps } from '../build/src/rdp/source-maps.js';

test('simple and indexed maps preserve original identity and expire', async () => {
  const maps = new SourceMaps();
  const raw = { version: 3, sources: ['entry.ts'], sourcesContent: ['let answer = 42;'], names: [], mappings: 'AAAA', sourceRoot: '/src/' };
  const loaded = await maps.load({ sourceActor: 'source-1', source: 'var answer=42;', map: raw, url: 'https://fixture.invalid/app.js.map' });
  assert.equal(maps.original(loaded.mapId, 1, 0).source, 'https://fixture.invalid/src/entry.ts');
  assert.equal(maps.generated(loaded.mapId, 'https://fixture.invalid/src/entry.ts', 1, 0).positions[0].line, 1);
  const indexed = await maps.load({ sourceActor: 'source-2', source: '\nvar answer=42;', map: { version: 3, sections: [{ offset: { line: 1, column: 0 }, map: raw }] } });
  assert.equal(maps.original(indexed.mapId, 2, 0).line, 1);
  maps.clear();
  assert.throws(() => maps.get(loaded.mapId), error => error.code === 'MAP_EXPIRED');
});

test('remote map requires opt-in and never accepts credential URLs', async () => {
  const maps = new SourceMaps();
  await assert.rejects(maps.load({ sourceActor: 'source', source: '', url: 'https://fixture.invalid/map' }), error => error.code === 'MAP_REMOTE_OPT_IN');
  await assert.rejects(maps.load({ sourceActor: 'source', source: '', url: 'https://user:pass@fixture.invalid/map', allowRemote: true }), error => error.code === 'MAP_URL_INVALID');
});
