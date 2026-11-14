import { RdpError } from '../rdp/index.js';
import { nativeResponse } from '../rdp/output.js';
const text = { type: 'string' };
const flag = { type: 'boolean' };
const count = { type: 'integer', minimum: 0 };
const identity = { targetId: text, pauseId: text };
const location = { ...identity, url: text, sourceActor: text, line: { type: 'integer', minimum: 1 }, column: count, condition: text, logValue: text };
export function registerNativeDebugTools(register, manager) {
    const add = (name, operation, description, properties = {}, required = []) => {
        register({
            tool: { name, description, inputSchema: { type: 'object', properties, required } },
            handler: async (args) => {
                try {
                    const text = nativeResponse(await manager.call(operation, args));
                    return { content: [{ type: 'text', text }], ...(text.includes('"code":"OUTPUT_LIMIT"') ? { isError: true } : {}) };
                }
                catch (error) {
                    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: error instanceof RdpError ? error.code : 'NATIVE_DEBUG_ERROR', message: error instanceof Error ? error.message : String(error), ...(error instanceof RdpError && error.details ? { details: error.details } : {}) } }) }] };
                }
            },
        });
    };
    add('ruyi_debug_enable', 'debug.enable', 'Attach Firefox native RDP in observe mode. Exact target identity is required; shared workers require exact sharedWorkerUrls; no script injection.', { debuggerPort: { type: 'integer', minimum: 1, maximum: 65535 }, descriptorActor: text, contextId: text, browserId: count, scope: { type: 'string', enum: ['tab', 'browser'] }, workers: flag, includeSharedWorkers: flag, sharedWorkerUrls: { type: 'array', maxItems: 16, uniqueItems: true, items: text }, mode: { type: 'string', enum: ['observe', 'armed'], default: 'observe' }, autoResumeAfter: { type: 'integer', minimum: 1, maximum: 30, default: 30 } });
    add('ruyi_debug_disable', 'debug.disable', 'Resume owned pauses, detach RDP, release observation lease. Never close an external browser.');
    add('ruyi_debug_status', 'debug.status', 'Read native session, target and pause identity without attaching.');
    add('ruyi_debug_capabilities', 'debug.capabilities', 'Report implemented native capabilities separately from runtime verification and unsupported combinations.');
    add('ruyi_debug_arm', 'debug.arm', 'Enable native breakpoints for this attached session.');
    add('ruyi_debug_observe', 'debug.observe', 'Disable breakpoint pauses and resume the current native pauses.');
    add('ruyi_debug_targets', 'debug.targets', 'List exact frame and worker targets. IDs expire when targets are destroyed.');
    add('ruyi_debug_select_target', 'debug.select_target', 'Select an exact native target, including iframe or worker.', { targetId: text }, ['targetId']);
    add('ruyi_debug_list_sources', 'debug.sources', 'List engine-loaded source actors in the selected target.', { targetId: text, urlContains: text });
    add('ruyi_debug_possible_breakpoints', 'debug.positions', 'Return native breakable line/column positions.', { ...identity, sourceActor: text, url: text, startLine: count, endLine: count, startColumn: count, endColumn: count });
    add('ruyi_debug_set_breakpoint', 'debug.set_breakpoint', 'Set exact sourceActor or pending URL breakpoint. condition and logValue use native RDP.', location, ['line']);
    add('ruyi_set_breakpoint_on_text', 'debug.set_breakpoint_on_text', 'Search loaded source and set a native breakpoint at an explicit occurrence.', { ...identity, text, urlFilter: text, sourceActor: text, occurrence: count, condition: text, logValue: text }, ['text']);
    add('ruyi_list_breakpoints', 'debug.list_breakpoints', 'List native code, logpoint, request and DOM breakpoints owned by this session.', { targetId: text });
    add('ruyi_remove_breakpoint', 'debug.remove_breakpoint', 'Remove exactly one session-owned native breakpoint.', { breakpointId: text }, ['breakpointId']);
    add('ruyi_debug_wait_paused', 'debug.wait_paused', 'Wait for a live pause; never return a resumed historical pause.', { ...identity, afterPauseId: text, timeout: { type: 'integer', minimum: 0, maximum: 120, default: 30 } });
    add('ruyi_debug_get_paused_info', 'debug.get_paused_info', 'Read the current pause and bounded stack.', identity);
    add('ruyi_debug_pause', 'debug.pause', 'Arm and interrupt the selected native target.', { targetId: text });
    add('ruyi_debug_resume', 'debug.resume', 'Resume a current pause, invalidating its frame and object handles.', identity);
    add('ruyi_debug_step', 'debug.step', 'Step over, into or out and wait for the next pause.', { ...identity, type: { type: 'string', enum: ['over', 'into', 'out'] }, timeout: { type: 'integer', minimum: 0, maximum: 120 } });
    add('ruyi_debug_restart_frame', 'debug.restart', 'Restart a live synchronous call frame. Previous side effects are not undone.', { ...identity, frameActor: text });
    add('ruyi_debug_run_to', 'debug.run_to', 'Set a temporary native breakpoint and resume; remove it at the next pause.', location, ['line']);
    add('ruyi_debug_get_frames', 'debug.frames', 'Read synchronous and saved async frames, preserving live/suspended status.', { ...identity, start: count, count: { type: 'integer', minimum: 1, maximum: 100 } });
    add('ruyi_debug_get_scopes', 'debug.scope', 'Read the current lexical and closure scope chain; global is excluded by default.', { ...identity, frameActor: text, includeParents: flag, includeGlobal: flag, maxDepth: { type: 'integer', minimum: 1, maximum: 20 } });
    add('ruyi_debug_expand_object', 'debug.expand', 'Page native object property descriptors without invoking getters.', { ...identity, actor: text, property: text, action: { type: 'string', enum: ['properties', 'release'] }, start: count, maxItems: { type: 'integer', minimum: 1, maximum: 200 } }, ['actor']);
    add('ruyi_debug_evaluate', 'debug.evaluate', 'Evaluate a focused native paused-frame expression; side effects disabled by default.', { ...identity, frameActor: text, expression: text, allowSideEffects: flag, timeout: { type: 'integer', minimum: 1, maximum: 15 } }, ['expression']);
    add('ruyi_debug_pause_on_exception', 'debug.pause_on_exceptions', 'Configure native caught/uncaught exception pauses.', { enabled: flag, ignoreCaught: flag });
    add('ruyi_break_on_xhr', 'debug.break_on_xhr', 'Set native page XHR/fetch breakpoint. Worker outgoing request breakpoint is unsupported.', { targetId: text, url: text, method: text }, ['url']);
    add('ruyi_debug_event_breakpoints', 'debug.events', 'List native event categories or set their exact IDs.', { targetId: text, ids: { type: 'array', items: text } });
    add('ruyi_debug_dom_breakpoint', 'debug.dom', 'Set native DOM subtree, attribute or removal breakpoint.', { targetId: text, selector: text, nodeActor: text, subtree: flag, attribute: flag, removal: flag });
    add('ruyi_debug_blackbox', 'debug.blackbox', 'Set or clear native source blackboxing, optionally by range.', { ...identity, sourceActor: text, url: text, enabled: flag, startLine: count, startColumn: count, endLine: count, endColumn: count });
    add('ruyi_debug_logpoints', 'debug.logs', 'Read bounded native logpoint and console events.', { limit: { type: 'integer', minimum: 1, maximum: 100 } });
    add('ruyi_debug_load_source_map', 'debug.map_load', 'Load an explicit local/data/remote source map. Remote reads omit credentials and reject redirects.', { targetId: text, sourceActor: text, map: { type: 'object' }, mapUrl: text, path: text, allowRemote: flag }, ['sourceActor']);
    add('ruyi_debug_original_location', 'debug.map_original', 'Map a generated position to an original source position.', { mapId: text, line: { type: 'integer', minimum: 1 }, column: count }, ['mapId', 'line']);
    add('ruyi_debug_original_source', 'debug.map_source', 'Read a bounded embedded original source window; never fetch missing originals implicitly.', { mapId: text, source: text, offset: count, length: { type: 'integer', minimum: 1, maximum: 65536 } }, ['mapId', 'source']);
    add('ruyi_debug_original_breakpoint', 'debug.map_breakpoint', 'Map an original source breakpoint to validated native generated locations.', { ...identity, mapId: text, source: text, line: { type: 'integer', minimum: 1 }, column: count, condition: text, logValue: text }, ['mapId', 'source', 'line']);
}
//# sourceMappingURL=native-debug.js.map