#!/usr/bin/env node
/**
 * Community MCP server for ruyiPage browser automation and inspection.
 *
 * Start with:
 *   node build/src/index.js
 * or configure the same entry point in an MCP client.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { cleanupServer, createServer } from './server.js';
import { PythonBridge } from './bridge/python.js';
async function main() {
    console.error('[ruyi-mcp] Starting ruyi-mcp v0.1.8...');
    console.error('[ruyi-mcp] Browser: Firefox runtime managed by ruyiPage');
    console.error('[ruyi-mcp] Protocol: WebDriver BiDi');
    console.error('[ruyi-mcp] Capabilities: automation, network inspection, fingerprint analysis, human-like interaction');
    console.error('[ruyi-mcp] Trace: ruyiPage WebDriver BiDi JSON Trace');
    const bridge = new PythonBridge();
    let server = null;
    let shutdownPromise = null;
    function shutdown(reason, code = 0, transportClosed = false) {
        if (code !== 0 || process.exitCode === undefined) {
            process.exitCode = code;
        }
        if (!shutdownPromise) {
            // Use a microtask so shutdownPromise is assigned before server.close()
            // can synchronously invoke server.onclose and re-enter this function.
            shutdownPromise = Promise.resolve().then(async () => {
                console.error(`[ruyi-mcp] ${reason} received`);
                const activeServer = server;
                if (activeServer && !transportClosed) {
                    await activeServer.close().catch((err) => {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(`[ruyi-mcp] Server close failed: ${message}`);
                    });
                }
                if (activeServer) {
                    await cleanupServer(activeServer);
                }
                else {
                    await bridge.stop().catch((err) => {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(`[ruyi-mcp] Bridge stop failed: ${message}`);
                    });
                }
            });
        }
        return shutdownPromise;
    }
    process.once('SIGINT', () => {
        void shutdown('SIGINT', 0);
    });
    process.once('SIGTERM', () => {
        void shutdown('SIGTERM', 0);
    });
    process.stdin.once('end', () => {
        void shutdown('stdin EOF', 0);
    });
    process.stdin.once('close', () => {
        void shutdown('stdin closed', 0);
    });
    process.stdout.on('error', (err) => {
        const isPipeClose = err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED';
        void shutdown(isPipeClose ? 'stdout EPIPE' : `stdout error: ${err.message}`, isPipeClose ? 0 : 1);
    });
    try {
        server = await createServer(bridge);
        const transport = new StdioServerTransport();
        server.onclose = () => {
            void cleanupServer(server);
            void shutdown('MCP transport closed', 0, true);
        };
        console.error('[ruyi-mcp] Connecting to MCP transport...');
        await server.connect(transport);
        console.error('[ruyi-mcp] Ready. Waiting for MCP requests...');
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ruyi-mcp] Fatal: ${message}`);
        await shutdown('fatal error', 1);
    }
}
main();
//# sourceMappingURL=index.js.map