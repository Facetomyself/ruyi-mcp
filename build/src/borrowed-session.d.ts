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
type BorrowedScope = {
    pageIdx?: unknown;
    frameContextId?: unknown;
};
export declare class BorrowedTraceSession {
    readonly sessionPath: string;
    private leaseId;
    private leaseLost;
    private controlConfirmed;
    private retirement;
    private retirementCheck;
    private retirementProven;
    private descriptor;
    private snapshot;
    private constructor();
    static attach(sessionPath: string): Promise<BorrowedTraceSession>;
    private static validate;
    currentDescriptor(): Promise<TraceSessionDescriptor>;
    assertScope({ pageIdx, frameContextId }: BorrowedScope): void;
    private loseControl;
    private retiredError;
    private checkRetirement;
    private closeRetirement;
    private assertLease;
    command(action: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
    private missingStatus;
    status(): Promise<Record<string, unknown>>;
    private validateOwner;
    debuggerLease(): {
        endpoint: string;
        target: string;
        token: string;
        leaseId?: string;
    };
    release(): Promise<'lease_released' | 'lease_already_lost'>;
    observe(maxNodes?: number, scope?: BorrowedScope): Promise<Record<string, unknown>>;
    act(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export {};
