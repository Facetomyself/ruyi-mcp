/**
 * ruyi-mcp MCP Server — registers all tools, dispatches calls via Python bridge.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { RuyiContext } from './ruyi-context.js';
import { registerPageTools } from './tools/page.js';
import { registerRuntimeTools } from './tools/runtime.js';
import { registerAntiDetectTools } from './tools/antidetect.js';
import { registerDomTools } from './tools/dom.js';
import { registerSessionTools } from './tools/session.js';
import { registerScriptTools } from './tools/script.js';
import { registerNetworkTools } from './tools/network.js';
import { registerDebugTools } from './tools/debug.js';
import { registerHumanTools } from './tools/human.js';
import { registerTraceTools } from './tools/trace.js';
import { registerNetEnhanceTools } from './tools/netenhance.js';
import { registerUtilTools } from './tools/util.js';
import { registerCookieTools } from './tools/cookie.js';
import { registerInterceptTools } from './tools/intercept.js';
import { registerWebSocketTools } from './tools/websocket.js';
const toolHandlers = new Map();
function register(entry) {
    toolHandlers.set(entry.tool.name, entry);
}
// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
export async function createServer(bridge) {
    const ctx = new RuyiContext(bridge);
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
    registerDebugTools(register, ctx);
    registerHumanTools(register, ctx);
    registerTraceTools(register, ctx);
    registerNetEnhanceTools(register, ctx);
    registerWebSocketTools(register, ctx);
    registerUtilTools(register, ctx);
    const tools = Array.from(toolHandlers.values()).map((h) => h.tool);
    const server = new Server({
        name: 'ruyi-mcp',
        version: '0.1.0',
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
        const entry = toolHandlers.get(name);
        if (!entry) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        try {
            const result = await entry.handler((args || {}));
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
    // Handle shutdown gracefully
    server.onclose = async () => {
        console.error('[ruyi-mcp] Server closing, cleaning up...');
        await ctx.quit().catch(() => { });
        await bridge.stop().catch(() => { });
    };
    return server;
}
//# sourceMappingURL=server.js.map