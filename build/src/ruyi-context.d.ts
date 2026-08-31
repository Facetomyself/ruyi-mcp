/**
 * RuyiContext — manages browser session state across MCP tool calls.
 *
 * Tracks: active browser, open pages, breakpoints, and network capture state.
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
    clearBreakpoints(pageIdx?: number): void;
    setCaptureActive(active: boolean, pattern?: string): void;
    reset(): void;
}
