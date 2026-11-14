import { parentPort } from 'node:worker_threads';
import { SourceMaps } from './source-maps.js';

const maps = new SourceMaps();
parentPort!.on('message', async (request: { id: number; operation: string; args: any[] }) => {
  try {
    const method = (maps as unknown as Record<string, (...args: any[]) => unknown>)[request.operation];
    if (!method) throw new Error('Unknown source map operation');
    const result = await method.apply(maps, request.args);
    parentPort!.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: { code: (error as any)?.code ?? 'MAP_INVALID', message: String(error) } });
  }
});
