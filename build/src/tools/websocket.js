/**
 * WebSocket message capture tools.
 * Uses JS WebSocket Proxy injection to capture frames.
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerWebSocketTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_websocket_inject
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_websocket_inject',
            description: '注入 WebSocket Proxy 以捕获后续 WebSocket 连接的消息。' +
                '注入后，新创建的 WebSocket 连接的 send/receive 消息会记录到 window.__ruyi_ws_messages。' +
                '⚠ 只能捕获注入后创建的 WebSocket 连接。binary 帧以 "[binary]" 标记。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('ws.inject', { pageIdx });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_get_websocket_messages
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_get_websocket_messages',
            description: '获取已注入 Proxy 后收集的 WebSocket 消息。' +
                '返回每连接的 url、sent、received 消息列表及时间戳。' +
                '设置 clear=true 可在读取后清空缓冲区。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    clear: { type: 'boolean', description: '读取后清空缓冲区，默认 false', default: false },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('ws.collect', {
                pageIdx,
                clear: args.clear ?? false,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
}
//# sourceMappingURL=websocket.js.map