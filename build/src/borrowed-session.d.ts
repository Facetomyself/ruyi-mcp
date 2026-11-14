export interface TraceSessionDescriptor {
    schema: string;
    runId: string;
    caseId?: string;
    phase: string;
    expiresAt?: string;
    runtime: {
        name?: string;
        version?: string;
        buildId?: string;
        binarySha256?: string;
        firefoxVersion?: string;
    };
    browser: {
        pid: number;
        creationTime?: string;
        executablePath: string;
        profilePath?: string;
    };
    bidi: {
        contextId: string;
    };
    rdp: {
        host: string;
        port: number;
        transport: string;
        browserId?: number;
        browsingContextId?: string | number;
    } | null;
    control: {
        endpoint: string;
        token: string;
    };
}
export declare class BorrowedTraceSession {
    readonly sessionPath: string;
    private leaseId;
    private descriptor;
    private snapshot;
    private constructor();
    static attach(sessionPath: string): Promise<BorrowedTraceSession>;
    private static validate;
    currentDescriptor(): Promise<TraceSessionDescriptor>;
    command(action: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
    status(): Promise<Record<string, unknown>>;
    private validateOwner;
    debuggerLease(): {
        endpoint: string;
        target: string;
        token: string;
        leaseId?: string;
    };
    release(): Promise<void>;
    observe(maxNodes?: number): Promise<Record<string, unknown>>;
    act(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
