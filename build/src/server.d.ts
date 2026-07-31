/**
 * ruyi-mcp MCP Server — registers all tools, dispatches calls via Python bridge.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { PythonBridge } from './bridge/python.js';
/**
 * Dispose the resources owned by one server instance.
 *
 * The returned promise is stable, so transport close, stdin EOF, and signal
 * handlers can race without quitting the browser or bridge more than once.
 */
export declare function cleanupServer(server: Server): Promise<void>;
export declare function createServer(bridge: PythonBridge): Promise<Server>;
