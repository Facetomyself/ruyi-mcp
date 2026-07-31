/**
 * Python subprocess bridge for ruyipage.
 *
 * Manages a long-lived Python child process running ruyi_bridge.py.
 * Communication via JSON-RPC over stdio: one JSON line per request/response.
 */
export interface PythonBridgeOptions {
    executable?: string;
    script?: string;
    env?: NodeJS.ProcessEnv;
}
export declare class PythonBridge {
    private readonly executable;
    private readonly script;
    private readonly extraEnv;
    private proc;
    private rl;
    private generation;
    private nextId;
    private pending;
    private ready;
    private readyResolve;
    private readyReject;
    private readyPromise;
    private stoppingPromise;
    constructor(options?: PythonBridgeOptions);
    private resetReadyPromise;
    private isActiveGeneration;
    private rejectGenerationPending;
    private closeReadline;
    private handleBridgeStdinError;
    private writeRequest;
    private killBridgeProcess;
    start(): Promise<void>;
    stop(): Promise<void>;
    private stopInternal;
    private waitForExit;
    call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params?: Record<string, unknown>): Promise<void>;
    isRunning(): boolean;
}
