/**
 * RuyiContext — manages browser session state across MCP tool calls.
 *
 * Tracks: active browser, open pages, breakpoints, trace state, network intercepts.
 */
import { PythonBridge } from './bridge/python.js';
export interface PageInfo {
    pageIdx: number;
    url: string;
    title: string;
}
export interface BreakpointInfo {
    breakpointId: string;
    text: string;
    mode?: 'text' | 'xhr';
    pattern?: string;
    urlFilter?: string;
    condition?: string;
    type: 'soft';
}
export interface SessionState {
    alive: boolean;
    browserLaunched: boolean;
    fingerprintApplied: boolean;
    traceEnabled: boolean;
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
    state: SessionState;
    constructor(bridge: PythonBridge);
    get bridgeInstance(): PythonBridge;
    launch(params: Record<string, unknown>): Promise<Record<string, unknown>>;
    quit(): Promise<void>;
    status(): Promise<Record<string, unknown>>;
    refreshPages(): Promise<PageInfo[]>;
    getActivePageIdx(): number;
    setActivePageIdx(idx: number): void;
    addBreakpoint(bp: BreakpointInfo): void;
    removeBreakpoint(breakpointId: string): void;
    getBreakpoints(): BreakpointInfo[];
    setCaptureActive(active: boolean, pattern?: string): void;
    setTraceEnabled(enabled: boolean): void;
    reset(): void;
}
