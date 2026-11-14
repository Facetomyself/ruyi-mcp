import { parentPort } from 'node:worker_threads';
import { SourceMaps } from './source-maps.js';
const maps = new SourceMaps();
parentPort.on('message', async (request) => {
    try {
        const method = maps[request.operation];
        if (!method)
            throw new Error('Unknown source map operation');
        const result = await method.apply(maps, request.args);
        parentPort.postMessage({ id: request.id, result });
    }
    catch (error) {
        parentPort.postMessage({ id: request.id, error: { code: error?.code ?? 'MAP_INVALID', message: String(error) } });
    }
});
//# sourceMappingURL=map-worker.js.map