import { EventEmitter } from 'node:events';
export type Packet = Record<string, any>;
export declare class RdpError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    constructor(code: string, message: string, details?: unknown | undefined);
}
export declare class RdpTransport extends EventEmitter {
    readonly epoch: `${string}-${string}-${string}-${string}-${string}`;
    private socket?;
    private buffer;
    private pending;
    private queues;
    private failure?;
    greeting?: Packet;
    get connected(): boolean;
    open(host: string, port: number, timeoutMs?: number): Promise<Packet>;
    request(actor: string, type: string, params?: Packet, timeoutMs?: number): Promise<Packet>;
    private exchange;
    private receive;
    close(reason?: RdpError): void;
}
