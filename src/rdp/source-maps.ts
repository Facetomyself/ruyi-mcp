import { AnyMap, allGeneratedPositionsFor, originalPositionFor, sourceContentFor, type TraceMap } from '@jridgewell/trace-mapping';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { RdpError } from './transport.js';

interface MapRecord { map: TraceMap; hash: string; sourceHash: string; sourceActor: string; url: string; }

export class SourceMaps {
  private maps = new Map<string, MapRecord>();
  clear(): void { this.maps.clear(); }

  async load(input: { sourceActor: string; source: string; map?: unknown; path?: string; url?: string; allowRemote?: boolean; }): Promise<Record<string, unknown>> {
    let raw = input.map;
    let mapUrl = input.url ?? '';
    if (input.path) {
      if (!isAbsolute(input.path)) throw new RdpError('INVALID_ARGUMENT', 'Source map path must be absolute');
      const data = await readFile(input.path);
      if (data.length > 16 * 1024 * 1024) throw new RdpError('MAP_LIMIT', 'Source map exceeds 16 MiB');
      raw = data.toString('utf8');
    } else if (raw === undefined && input.url?.startsWith('data:')) {
      const comma = input.url.indexOf(',');
      if (comma < 0) throw new RdpError('MAP_INVALID', 'Invalid data URL');
      const header = input.url.slice(0, comma);
      raw = /;base64$/i.test(header) ? Buffer.from(input.url.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(input.url.slice(comma + 1));
      mapUrl = '';
    } else if (raw === undefined && input.url) {
      if (!input.allowRemote) throw new RdpError('MAP_REMOTE_OPT_IN', 'Set allowRemote=true to read this source map URL');
      const parsed = new URL(input.url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new RdpError('MAP_URL_INVALID', 'Source map URL must be HTTP(S) without credentials');
      const response = await fetch(parsed, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new RdpError('MAP_HTTP', `Source map HTTP ${response.status}`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw new RdpError('MAP_INVALID', 'Empty source map response');
      for await (const chunk of response.body as any) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new RdpError('MAP_LIMIT', 'Source map exceeds 16 MiB');
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks).toString('utf8');
    }
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text || Buffer.byteLength(text) > 16 * 1024 * 1024) throw new RdpError('MAP_INVALID', 'A source map up to 16 MiB is required');
    let map: TraceMap;
    try { map = AnyMap(JSON.parse(text), mapUrl || undefined); }
    catch (error) { throw new RdpError('MAP_INVALID', String(error)); }
    const mapId = randomUUID();
    const hash = createHash('sha256').update(text).digest('hex');
    const sourceHash = createHash('sha256').update(input.source).digest('hex');
    this.maps.set(mapId, { map, hash, sourceHash, sourceActor: input.sourceActor, url: mapUrl });
    return { mapId, hash, sourceHash, sourceActor: input.sourceActor, sources: map.resolvedSources, remoteCredentials: 'omitted' };
  }

  get(mapId: string): MapRecord {
    const record = this.maps.get(mapId);
    if (!record) throw new RdpError('MAP_EXPIRED', 'Unknown or expired source map');
    return record;
  }

  generated(mapId: string, source: string, line: number, column = 0): Record<string, unknown> {
    const record = this.get(mapId);
    const positions = allGeneratedPositionsFor(record.map, { source, line, column });
    return { mapId, sourceActor: record.sourceActor, mapHash: record.hash, sourceHash: record.sourceHash, positions };
  }

  original(mapId: string, line: number, column: number): unknown {
    return originalPositionFor(this.get(mapId).map, { line, column });
  }

  content(mapId: string, source: string): string | null { return sourceContentFor(this.get(mapId).map, source); }
}
