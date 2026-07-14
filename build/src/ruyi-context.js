/**
 * RuyiContext — manages browser session state across MCP tool calls.
 *
 * Tracks: active browser, open pages, breakpoints, trace state, network intercepts.
 */
function createInitialState() {
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
    bridge;
    state = createInitialState();
    constructor(bridge) {
        this.bridge = bridge;
    }
    get bridgeInstance() {
        return this.bridge;
    }
    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    async launch(params) {
        const result = (await this.bridge.call('browser.launch', params));
        this.state.browserLaunched = true;
        this.state.alive = true;
        this.state.activePageIdx = result.pageIdx || 0;
        this.state.lastLaunchParams = params;
        if (params.fingerprint) {
            this.state.fingerprintApplied = true;
        }
        if (params.traceEnabled) {
            this.state.traceEnabled = true;
        }
        if (params.proxy) {
            this.state.proxy = params.proxy;
        }
        // Fetch page list
        await this.refreshPages();
        return result;
    }
    async quit() {
        try {
            await this.bridge.call('browser.quit', {}, 10000);
        }
        catch {
            // Ignore quit errors
        }
        this.state = createInitialState();
    }
    async status() {
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
    // ------------------------------------------------------------------
    // Capture / Trace
    // ------------------------------------------------------------------
    setCaptureActive(active, pattern) {
        this.state.captureActive = active;
        if (pattern !== undefined) {
            this.state.capturePattern = pattern;
        }
    }
    setTraceEnabled(enabled) {
        this.state.traceEnabled = enabled;
    }
    // ------------------------------------------------------------------
    // Reset
    // ------------------------------------------------------------------
    reset() {
        this.state = createInitialState();
    }
}
//# sourceMappingURL=ruyi-context.js.map