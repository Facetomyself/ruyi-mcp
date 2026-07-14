/**
 * Network intercept tools: intercept_requests, intercept_responses, intercept_wait, intercept_stop.
 * Wraps ruyipage's page.intercept API (BiDi network.addIntercept).
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerInterceptTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_intercept_requests
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_intercept_requests',
            description: '开始拦截 HTTP 请求（beforeRequestSent 阶段）。' +
                '支持 URL 模式过滤。拦截的请求用 ruyi_intercept_wait 消费。' +
                '可修改/拦截/模拟请求（未来版本）。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    urlPatterns: {
                        type: 'array',
                        description: 'URL 过滤模式。格式: [{"type":"string","pattern":"/api/"}] ' +
                            '或 [{"type":"pattern","protocol":"https","pathname":"/api/*"}]',
                        items: { type: 'object' },
                    },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('intercept.start_req', {
                pageIdx,
                urlPatterns: args.urlPatterns,
            });
            if (result.intercepting) {
                ctx.setCaptureActive(true, 'intercept_req');
            }
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_intercept_responses
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_intercept_responses',
            description: '开始拦截 HTTP 响应（responseStarted 阶段）。' +
                '支持 URL 模式过滤。拦截的响应用 ruyi_intercept_wait 消费。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    urlPatterns: {
                        type: 'array',
                        description: 'URL 过滤模式。同 ruyi_intercept_requests 格式。',
                        items: { type: 'object' },
                    },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('intercept.start_resp', {
                pageIdx,
                urlPatterns: args.urlPatterns,
            });
            if (result.intercepting) {
                ctx.setCaptureActive(true, 'intercept_resp');
            }
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_intercept_wait
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_intercept_wait',
            description: '等待并消费一个拦截到的请求/响应。队列模式：每次调用返回一个。' +
                '超时返回 timedOut=true。返回 url、method、headers、body、responseStatus 等。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    timeout: { type: 'number', description: '等待超时（秒），默认 10', default: 10 },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('intercept.wait', {
                pageIdx,
                timeout: args.timeout ?? 10,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_intercept_stop
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_intercept_stop',
            description: '停止所有网络拦截。',
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
            await ctx.bridgeInstance.call('intercept.stop', { pageIdx });
            ctx.setCaptureActive(false);
            return {
                content: [{ type: 'text', text: jsonResult({ intercepting: false }) }],
            };
        }),
    });
}
//# sourceMappingURL=intercept.js.map