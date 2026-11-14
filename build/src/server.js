/**
 * ruyi-mcp MCP Server — registers all tools, dispatches calls via Python bridge.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { RuyiContext } from './ruyi-context.js';
import { ToolRegistry } from './tool-registry.js';
import { NativeDebuggerManager } from './rdp/manager.js';
import { registerNativeDebugTools } from './tools/native-debug.js';
import { registerPageTools } from './tools/page.js';
import { registerRuntimeTools } from './tools/runtime.js';
import { registerAntiDetectTools } from './tools/antidetect.js';
import { registerDomTools } from './tools/dom.js';
import { registerSessionTools } from './tools/session.js';
import { registerScriptTools } from './tools/script.js';
import { registerNetworkTools } from './tools/network.js';
import { registerPreloadTools } from './tools/preload.js';
import { registerTraceTools } from './tools/trace.js';
import { registerBorrowedSessionTools } from './tools/borrowed-session.js';
import { registerHumanTools } from './tools/human.js';
import { registerNetEnhanceTools } from './tools/netenhance.js';
import { registerUtilTools } from './tools/util.js';
import { registerCookieTools } from './tools/cookie.js';
import { registerInterceptTools } from './tools/intercept.js';
import { registerWebSocketTools } from './tools/websocket.js';
import { registerDownloadTools } from './tools/downloads.js';
import { registerAgentTools } from './tools/agent.js';
import { AGENT_LOOP_TOOLS, AGENT_TOOLS, COMPACT_TOOLS, EXPERT_ONLY_TOOLS, resolveToolset, } from './tools/toolset.js';
export const SERVER_VERSION = '0.4.0';
const serverCleanups = new WeakMap();
/**
 * Dispose the resources owned by one server instance.
 *
 * The returned promise is stable, so transport close, stdin EOF, and signal
 * handlers can race without quitting the browser or bridge more than once.
 */
export function cleanupServer(server) {
    return serverCleanups.get(server)?.() ?? Promise.resolve();
}
// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
export async function createServer(bridge) {
    const ctx = new RuyiContext(bridge);
    const manager = new NativeDebuggerManager(() => ctx.getNativeDebugSession());
    ctx.setDebugger(manager);
    const registry = new ToolRegistry();
    const register = registry.register;
    for (const event of ['paused', 'resumed', 'target', 'target-destroyed', 'invalidated', 'diagnostic']) {
        manager.on(event, (payload) => {
            try {
                ctx.debugEvidence.configure(ctx.state.lastLaunchParams ?? {});
                ctx.debugEvidence.record(`debug.${event}`, payload);
            }
            catch {
                console.error('[ruyi-mcp] Debugger evidence write failed');
            }
        });
    }
    // Register tools from all modules
    registerPageTools(register, ctx);
    registerScriptTools(register, ctx);
    registerRuntimeTools(register, ctx);
    registerAntiDetectTools(register, ctx);
    registerDomTools(register, ctx);
    registerSessionTools(register, ctx);
    registerCookieTools(register, ctx);
    registerNetworkTools(register, ctx);
    registerInterceptTools(register, ctx);
    registerNativeDebugTools((entry) => register({
        tool: entry.tool,
        handler: async (args) => {
            ctx.debugEvidence.configure(ctx.state.lastLaunchParams ?? {});
            const result = await entry.handler(args);
            const evidence = ctx.debugEvidence.record(entry.tool.name, result);
            return evidence ? { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ evidence }) }] } : result;
        },
    }), manager);
    registerPreloadTools(register, ctx);
    registerTraceTools(register, ctx);
    registerBorrowedSessionTools(register, ctx);
    registerHumanTools(register, ctx);
    registerNetEnhanceTools(register, ctx);
    registerDownloadTools(register, ctx);
    registerWebSocketTools(register, ctx);
    registerUtilTools(register, ctx);
    registerAgentTools(register, ctx);
    registry.registerDiscovery();
    const toolset = resolveToolset();
    const tools = [...registry.entries.values()].map((entry) => entry.tool).filter((tool) => {
        if (toolset === 'compact')
            return COMPACT_TOOLS.has(tool.name);
        if (toolset === 'agent')
            return AGENT_TOOLS.has(tool.name);
        if (toolset === 'automation')
            return !EXPERT_ONLY_TOOLS.has(tool.name) && !tool.name.startsWith('ruyi_debug_') && !AGENT_LOOP_TOOLS.has(tool.name);
        if (toolset === 'debug')
            return !AGENT_LOOP_TOOLS.has(tool.name);
        return true;
    });
    const server = new Server({
        name: 'ruyi-mcp',
        version: SERVER_VERSION,
    }, {
        capabilities: {
            tools: {},
        },
    });
    // List tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools };
    });
    // Call tool
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const entry = registry.entries.get(name);
        if (!entry) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        try {
            const result = await registry.execute(name, args ?? {});
            return result;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[ruyi-mcp] Tool error [${name}]:`, message);
            return {
                content: [{ type: 'text', text: `Tool error [${name}]: ${message}` }],
                isError: true,
            };
        }
    });
    let cleanupPromise = null;
    const cleanup = () => {
        if (!cleanupPromise) {
            // Defer execution by one microtask so cleanupPromise is assigned before
            // another close path can re-enter this function.
            cleanupPromise = Promise.resolve().then(async () => {
                await manager.close().catch(() => { });
                await ctx.releaseBorrowedSession().catch(() => { });
                console.error('[ruyi-mcp] Server closing, cleaning up...');
                if (bridge.isRunning()) {
                    await ctx.quit().catch(() => { });
                }
                await bridge.stop().catch(() => { });
            });
        }
        return cleanupPromise;
    };
    serverCleanups.set(server, cleanup);
    server.onclose = () => {
        void cleanup();
    };
    return server;
}
//# sourceMappingURL=server.js.map