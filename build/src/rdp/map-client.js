import { Worker } from 'node:worker_threads';
import { RdpError } from './transport.js';
export class AsyncSourceMaps {
    worker;
    sequence = 0;
    pending = new Map();
    call(operation, ...args) {
        if (!this.worker) {
            const worker = new Worker(new URL('./map-worker.js', import.meta.url));
            this.worker = worker;
            worker.unref();
            worker.on('message', response => {
                const pending = this.pending.get(response.id);
                if (!pending)
                    return;
                clearTimeout(pending.timer);
                this.pending.delete(response.id);
                if (response.error)
                    pending.reject(new RdpError(response.error.code, response.error.message));
                else
                    pending.resolve(response.result);
            });
            worker.on('error', error => this.clear(error));
            worker.on('exit', code => { if (this.worker === worker)
                this.clear(new Error(`Map worker exited ${code}`)); });
        }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.clear(new RdpError('MAP_TIMEOUT', 'Map worker budget exceeded')), 15_000);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ id, operation, args });
        });
    }
    load(input) { return this.call('load', input); }
    generated(mapId, source, line, column) { return this.call('generated', mapId, source, line, column); }
    original(mapId, line, column) { return this.call('original', mapId, line, column); }
    content(mapId, source) { return this.call('content', mapId, source); }
    clear(reason = new RdpError('MAP_EXPIRED', 'Source map session expired')) {
        const worker = this.worker;
        this.worker = undefined;
        void worker?.terminate();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(reason);
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=map-client.js.map