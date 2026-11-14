/**
 * RuyiContext — manages browser session state across MCP tool calls.
 *
 * Tracks: active browser, open pages, breakpoints, and network capture state.
 */
import { PythonBridge } from './bridge/python.js';
import { BorrowedTraceSession } from './borrowed-session.js';
import type { NativeDebuggerManager } from './rdp/manager.js';
import { DebugEvidence } from './debug-evidence.js';
export interface PageInfo {
    pageIdx: number;
    url: string;
    title: string;
}
export interface BreakpointInfo {
    breakpointId: string;
    text: string;
    mode?: 'text' | 'xhr' | 'xhr-native' | 'location';
    pattern?: string;
    urlFilter?: string;
    condition?: string;
    type: 'native' | 'soft';
    pageIdx?: number;
    url?: string;
    sourceActor?: string;
    line?: number;
    column?: number;
}
export interface SessionState {
    alive: boolean;
    browserLaunched: boolean;
    fingerprintApplied: boolean;
    pages: PageInfo[];
    activePageIdx: number;
    breakpoints: BreakpointInfo[];
    captureActive: boolean;
    capturePattern: string;
    proxy: string | null;
    lastLaunchParams: Record<string, unknown> | null;
}
export declare class RuyiContext {
    private bridge;
    private debuggerManager;
    borrowedSession: BorrowedTraceSession | undefined;
    readonly debugEvidence: DebugEvidence;
    state: SessionState;
    constructor(bridge: PythonBridge);
    get bridgeInstance(): PythonBridge;
    setDebugger(manager: NativeDebuggerManager): void;
    debuggerCall(operation: string, args?: Record<string, unknown>): Promise<unknown>;
    getNativeDebugSession(): Promise<{
        host: string;
        port: number;
        contextId: string | number | undefined;
        browserId: number | undefined;
        runId: string;
        pid: number;
        owner: "external";
        runtime: {
            version: string | undefined;
            buildId: string | undefined;
            sha256: string | undefined;
        };
        lease: {
            endpoint: string;
            target: string;
            token: string;
            leaseId?: string;
        };
    } | {
        host: string;
        port: number;
        contextId: string | undefined;
        pid: number | undefined;
        owner: "external" | "owned";
        browserId?: undefined;
        runId?: undefined;
        runtime?: undefined;
        lease?: undefined;
    } | null>;
    attachBorrowedSession(sessionPath: string): Promise<Record<string, unknown>>;
    releaseBorrowedSession(): Promise<void>;
    launch(params: Record<string, unknown>): Promise<Record<string, unknown>>;
    quit(): Promise<void>;
    status(): Promise<Record<string, unknown>>;
    refreshPages(): Promise<PageInfo[]>;
    getActivePageIdx(): number;
    setActivePageIdx(idx: number): void;
    addBreakpoint(bp: BreakpointInfo): void;
    removeBreakpoint(breakpointId: string): void;
    getBreakpoints(): BreakpointInfo[];
    clearBreakpoints(pageIdx?: number): void;
    setCaptureActive(active: boolean, pattern?: string): void;
    reset(): void;
}
