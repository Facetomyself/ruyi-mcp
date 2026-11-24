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

function createInitialState(): SessionState {
  return {
    alive: false,
    browserLaunched: false,
    fingerprintApplied: false,
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
  private debuggerManager: NativeDebuggerManager | undefined;
  borrowedSession: BorrowedTraceSession | undefined;
  readonly debugEvidence = new DebugEvidence();
  state: SessionState = createInitialState();

  constructor(bridge: PythonBridge) {
    this.bridge = bridge;
  }

  get bridgeInstance(): PythonBridge {
    if (this.borrowedSession) {
      throw new Error('This operation needs an owned automation session; use ruyi_trace_control for the borrowed trace session');
    }
    return this.bridge;
  }

  setDebugger(manager: NativeDebuggerManager): void {
    this.debuggerManager = manager;
  }

  async debuggerCall(operation: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.debuggerManager) throw new Error('Native debugger unavailable');
    this.debugEvidence.configure(this.state.lastLaunchParams ?? {});
    const result = await this.debuggerManager.call(operation, args);
    const evidence = this.debugEvidence.record(operation, result);
    return evidence && result && typeof result === 'object' && !Array.isArray(result) ? { ...result, evidence } : result;
  }

  async getNativeDebugSession() {
    if (this.borrowedSession) {
      const descriptor = await this.borrowedSession.currentDescriptor();
      if (!descriptor.rdp) throw new Error('Borrowed Trace owner has no RDP reservation');
      return {
        host: descriptor.rdp.host, port: descriptor.rdp.port, contextId: descriptor.rdp.browsingContextId, browserId: descriptor.rdp.browserId,
        runId: descriptor.runId, pid: descriptor.browser.pid, owner: 'external' as const,
        runtime: { version: descriptor.runtime.firefoxVersion || descriptor.runtime.version, buildId: descriptor.runtime.buildId, sha256: descriptor.runtime.binarySha256 },
        lease: this.borrowedSession.debuggerLease(),
      };
    }
    const status = await this.bridge.call('browser.status', { pageIdx: this.getActivePageIdx() }) as Record<string, unknown>;
    if (status.alive !== true || !Number.isInteger(status.debuggerPort)) return null;
    return {
      host: '127.0.0.1', port: Number(status.debuggerPort), contextId: status.contextId as string | undefined,
      pid: status.browserPid as number | undefined, owner: status.attached ? 'external' as const : 'owned' as const,
    };
  }

  async attachBorrowedSession(sessionPath: string): Promise<Record<string, unknown>> {
    if (this.borrowedSession || this.state.browserLaunched) throw new Error('A session is already active; quit or detach first');
    this.borrowedSession = await BorrowedTraceSession.attach(sessionPath);
    this.state.alive = true;
    return this.borrowedSession.status();
  }

  async releaseBorrowedSession(): Promise<void> {
    if (!this.borrowedSession) return;
    await this.debuggerManager?.close();
    try {
      await this.borrowedSession.release();
    } finally {
      this.borrowedSession = undefined;
      this.state = createInitialState();
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async launch(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.borrowedSession) throw new Error('Detach the borrowed trace session before launching another browser');
    this.debugEvidence.configure(params);
    const result = (await this.bridge.call('browser.launch', params)) as Record<string, unknown>;

    this.state.browserLaunched = true;
    this.state.alive = true;
    this.state.activePageIdx = (result.pageIdx as number) || 0;
    this.state.lastLaunchParams = params;

    if (params.fingerprint) {
      this.state.fingerprintApplied = true;
    }
    if (params.proxy) {
      this.state.proxy = params.proxy as string;
    }

    // Fetch page list
    await this.refreshPages();

    return result;
  }

  async quit(): Promise<void> {
    await this.debuggerManager?.close();
    if (this.borrowedSession) {
      await this.releaseBorrowedSession();
      return;
    }
    try {
      await this.bridge.call('browser.quit', {}, 10000);
    } catch {
      // Ignore quit errors
    }
    this.state = createInitialState();
  }

  async status(): Promise<Record<string, unknown>> {
    if (this.borrowedSession) return this.borrowedSession.status();
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

  clearBreakpoints(pageIdx?: number): void {
    if (pageIdx === undefined) {
      this.state.breakpoints = [];
      return;
    }
    this.state.breakpoints = this.state.breakpoints.filter(
      (bp) => bp.pageIdx !== pageIdx
    );
  }

  // ------------------------------------------------------------------
  // Capture
  // ------------------------------------------------------------------

  setCaptureActive(active: boolean, pattern?: string): void {
    this.state.captureActive = active;
    if (pattern !== undefined) {
      this.state.capturePattern = pattern;
    }
  }

  // ------------------------------------------------------------------
  // Reset
  // ------------------------------------------------------------------

  reset(): void {
    this.state = createInitialState();
  }
}
