export declare class DebugEvidence {
    private destination?;
    private caseId?;
    private runId?;
    private readonly digest;
    private count;
    private bytes;
    private configured;
    configure(args?: Record<string, unknown>): void;
    record(action: string, payload: unknown): Record<string, unknown> | undefined;
    pointer(): Record<string, unknown> | undefined;
}
