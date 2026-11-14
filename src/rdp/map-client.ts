import { Worker } from 'node:worker_threads';
import { RdpError } from './transport.js';

export class AsyncSourceMaps {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private call(operation: string, ...args: unknown[]): Promise<any> {
    if (!this.worker) {
      const worker = new Worker(new URL('./map-worker.js', import.meta.url));
      this.worker = worker;
      worker.unref();
      worker.on('message', response => {
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) pending.reject(new RdpError(response.error.code, response.error.message));
        else pending.resolve(response.result);
      });
      worker.on('error', error => this.clear(error));
      worker.on('exit', code => { if (this.worker === worker) this.clear(new Error(`Map worker exited ${code}`)); });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.clear(new RdpError('MAP_TIMEOUT', 'Map worker budget exceeded')), 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, operation, args });
    });
  }

  load(input: unknown): Promise<any> { return this.call('load', input); }
  generated(mapId: string, source: string, line: number, column: number): Promise<any> { return this.call('generated', mapId, source, line, column); }
  original(mapId: string, line: number, column: number): Promise<any> { return this.call('original', mapId, line, column); }
  content(mapId: string, source: string): Promise<any> { return this.call('content', mapId, source); }
  clear(reason: Error = new RdpError('MAP_EXPIRED', 'Source map session expired')): void {
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
  }
}
