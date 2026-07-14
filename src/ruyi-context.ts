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

function createInitialState(): SessionState {
  return {
    alive: false,
    browserLaunched: false,
    fingerprintApplied: false,
    traceEnabled: false,
    pages: [],
    activePageIdx: 0,
    breakpoints: [],
    captureActive: false,
    capturePattern: '',
    proxy: null,
    lastLaunchParams: null,
  };
}

export class RuyiContext {
  private bridge: PythonBridge;
  state: SessionState = createInitialState();

  constructor(bridge: PythonBridge) {
    this.bridge = bridge;
  }

  get bridgeInstance(): PythonBridge {
    return this.bridge;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async launch(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await this.bridge.call('browser.launch', params)) as Record<string, unknown>;

    this.state.browserLaunched = true;
    this.state.alive = true;
    this.state.activePageIdx = (result.pageIdx as number) || 0;
    this.state.lastLaunchParams = params;

    if (params.fingerprint) {
      this.state.fingerprintApplied = true;
    }
    if (params.traceEnabled) {
      this.state.traceEnabled = true;
    }
    if (params.proxy) {
      this.state.proxy = params.proxy as string;
    }

    // Fetch page list
    await this.refreshPages();

    return result;
  }

  async quit(): Promise<void> {
    try {
      await this.bridge.call('browser.quit', {}, 10000);
    } catch {
      // Ignore quit errors
    }
    this.state = createInitialState();
  }

  async status(): Promise<Record<string, unknown>> {
    try {
      const result = (await this.bridge.call('browser.status')) as Record<string, unknown>;
      this.state.alive = result.alive as boolean;
      return result;
    } catch {
      this.state.alive = false;
      return { alive: false };
    }
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------

  async refreshPages(): Promise<PageInfo[]> {
    try {
      const result = (await this.bridge.call('page.list')) as {
        tabs: PageInfo[];
      };
      this.state.pages = result.tabs || [];
      return this.state.pages;
    } catch {
      return this.state.pages;
    }
  }

  getActivePageIdx(): number {
    return this.state.activePageIdx;
  }

  setActivePageIdx(idx: number): void {
    this.state.activePageIdx = idx;
  }

  // ------------------------------------------------------------------
  // Breakpoints
  // ------------------------------------------------------------------

  addBreakpoint(bp: BreakpointInfo): void {
    this.state.breakpoints.push(bp);
  }

  removeBreakpoint(breakpointId: string): void {
    this.state.breakpoints = this.state.breakpoints.filter(
      (bp) => bp.breakpointId !== breakpointId
    );
  }

  getBreakpoints(): BreakpointInfo[] {
    return this.state.breakpoints;
  }

  // ------------------------------------------------------------------
  // Capture / Trace
  // ------------------------------------------------------------------

  setCaptureActive(active: boolean, pattern?: string): void {
    this.state.captureActive = active;
    if (pattern !== undefined) {
      this.state.capturePattern = pattern;
    }
  }

  setTraceEnabled(enabled: boolean): void {
    this.state.traceEnabled = enabled;
  }

  // ------------------------------------------------------------------
  // Reset
  // ------------------------------------------------------------------

  reset(): void {
    this.state = createInitialState();
  }
}
