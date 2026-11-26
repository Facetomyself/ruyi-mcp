import { type BigIntStats } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import type { TraceSessionDescriptor } from './borrowed-session.js';
type ProcessIdentity = {
    pid: number;
    startTime: string;
};
export type PinnedTraceRun = {
    out: string;
    uid: bigint;
    bootId: string;
    pidNamespace: string;
    run: FileHandle;
    runStat: BigIntStats;
    control: FileHandle;
    controlStat: BigIntStats;
    owner: ProcessIdentity;
    browser: ProcessIdentity;
    descriptor: TraceSessionDescriptor;
};
export declare function closePinnedTraceRun(run: PinnedTraceRun): Promise<void>;
export declare function pinTraceRun(sessionPath: string, descriptor: TraceSessionDescriptor): Promise<PinnedTraceRun | undefined>;
export declare function proveTraceRetirement(run: PinnedTraceRun, sessionPath: string): Promise<boolean>;
export {};
