/**
 * ruyi-mcp MCP Server — registers all tools, dispatches calls via Python bridge.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { PythonBridge } from './bridge/python.js';
export declare function createServer(bridge: PythonBridge): Promise<Server>;
