/**
 * RuyiContext — manages browser session state across MCP tool calls.
 *
 * Tracks: active browser, open pages, breakpoints, and network capture state.
 */
import { BorrowedTraceSession } from './borrowed-session.js';
import { DebugEvidence } from './debug-evidence.js';
function createInitialState() {
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
    bridge;
    debuggerManager;
    borrowedSession;
    debugEvidence = new DebugEvidence();
    state = createInitialState();
    constructor(bridge) {
        this.bridge = bridge;
    }
    get bridgeInstance() {
        if (this.borrowedSession) {
            throw new Error('This operation needs an owned automation session; use ruyi_trace_control for the borrowed trace session');
        }
        return this.bridge;
    }
    setDebugger(manager) {
        this.debuggerManager = manager;
    }
    async debuggerCall(operation, args = {}) {
        if (!this.debuggerManager)
            throw new Error('Native debugger unavailable');
        this.debugEvidence.configure(this.state.lastLaunchParams ?? {});
        const result = await this.debuggerManager.call(operation, args);
        const evidence = this.debugEvidence.record(operation, result);
        return evidence && result && typeof result === 'object' && !Array.isArray(result) ? { ...result, evidence } : result;
    }
    async getNativeDebugSession() {
        if (this.borrowedSession) {
            const descriptor = await this.borrowedSession.currentDescriptor();
            if (!descriptor.rdp)
                return null;
            return {
                host: descriptor.rdp.host, port: descriptor.rdp.port, contextId: descriptor.rdp.browsingContextId, browserId: descriptor.rdp.browserId,
                runId: descriptor.runId, pid: descriptor.browser.pid, owner: 'external',
                runtime: { version: descriptor.runtime.firefoxVersion || descriptor.runtime.version, buildId: descriptor.runtime.buildId, sha256: descriptor.runtime.binarySha256 },
                lease: this.borrowedSession.debuggerLease(),
            };
        }
        const status = await this.bridge.call('browser.status', { pageIdx: this.getActivePageIdx() });
        if (status.alive !== true || !Number.isInteger(status.debuggerPort))
            return null;
        return {
            host: '127.0.0.1', port: Number(status.debuggerPort), contextId: status.contextId,
            pid: status.browserPid, owner: status.attached ? 'external' : 'owned',
        };
    }
    async attachBorrowedSession(sessionPath) {
        if (this.borrowedSession || this.state.browserLaunched)
            throw new Error('A session is already active; quit or detach first');
        this.borrowedSession = await BorrowedTraceSession.attach(sessionPath);
        this.state.alive = true;
        return this.borrowedSession.status();
    }
    async releaseBorrowedSession() {
        if (!this.borrowedSession)
            return;
        await this.debuggerManager?.close();
        try {
            await this.borrowedSession.release();
        }
        finally {
            this.borrowedSession = undefined;
            this.state = createInitialState();
        }
    }
    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    async launch(params) {
        if (this.borrowedSession)
            throw new Error('Detach the borrowed trace session before launching another browser');
        this.debugEvidence.configure(params);
        const result = (await this.bridge.call('browser.launch', params));
        this.state.browserLaunched = true;
        this.state.alive = true;
        this.state.activePageIdx = result.pageIdx || 0;
        this.state.lastLaunchParams = params;
        if (params.fingerprint) {
            this.state.fingerprintApplied = true;
        }
        if (params.proxy) {
            this.state.proxy = params.proxy;
        }
        // Fetch page list
        await this.refreshPages();
        return result;
    }
    async quit() {
        await this.debuggerManager?.close();
        if (this.borrowedSession) {
            await this.releaseBorrowedSession();
            return;
        }
        try {
            await this.bridge.call('browser.quit', {}, 10000);
        }
        catch {
            // Ignore quit errors
        }
        this.state = createInitialState();
    }
    async status() {
        if (this.borrowedSession)
            return this.borrowedSession.status();
        try {
            const result = (await this.bridge.call('browser.status'));
            this.state.alive = result.alive;
            return result;
        }
        catch {
            this.state.alive = false;
            return { alive: false };
        }
    }
    // ------------------------------------------------------------------
    // Pages
    // ------------------------------------------------------------------
    async refreshPages() {
        try {
            const result = (await this.bridge.call('page.list'));
            this.state.pages = result.tabs || [];
            return this.state.pages;
        }
        catch {
            return this.state.pages;
        }
    }
    getActivePageIdx() {
        return this.state.activePageIdx;
    }
    setActivePageIdx(idx) {
        this.state.activePageIdx = idx;
    }
    // ------------------------------------------------------------------
    // Breakpoints
    // ------------------------------------------------------------------
    addBreakpoint(bp) {
        this.state.breakpoints.push(bp);
    }
    removeBreakpoint(breakpointId) {
        this.state.breakpoints = this.state.breakpoints.filter((bp) => bp.breakpointId !== breakpointId);
    }
    getBreakpoints() {
        return this.state.breakpoints;
    }
    clearBreakpoints(pageIdx) {
        if (pageIdx === undefined) {
            this.state.breakpoints = [];
            return;
        }
        this.state.breakpoints = this.state.breakpoints.filter((bp) => bp.pageIdx !== pageIdx);
    }
    // ------------------------------------------------------------------
    // Capture
    // ------------------------------------------------------------------
    setCaptureActive(active, pattern) {
        this.state.captureActive = active;
        if (pattern !== undefined) {
            this.state.capturePattern = pattern;
        }
    }
    // ------------------------------------------------------------------
    // Reset
    // ------------------------------------------------------------------
    reset() {
        this.state = createInitialState();
    }
}
//# sourceMappingURL=ruyi-context.js.map