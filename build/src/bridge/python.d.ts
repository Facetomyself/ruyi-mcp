/**
 * Python subprocess bridge for ruyipage.
 *
 * Manages a long-lived Python child process running ruyi_bridge.py.
 * Communication via JSON-RPC over stdio: one JSON line per request/response.
 */
export declare class PythonBridge {
    private proc;
    private rl;
    private nextId;
    private pending;
    private ready;
    private readyResolve;
    private readyReject;
    private readyPromise;
    private stderrLog;
    constructor();
    private resetReadyPromise;
    private rejectAllPending;
    private closeReadline;
    private killProcessTree;
    start(): Promise<void>;
    stop(): Promise<void>;
    private waitForExit;
    call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params?: Record<string, unknown>): Promise<void>;
    isRunning(): boolean;
}
