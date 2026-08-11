/**
 * Network intercept tools: intercept_requests, intercept_responses, intercept_wait, intercept_stop.
 * Wraps ruyipage's page.intercept API (BiDi network.addIntercept).
 */
import { getPageIdx } from './types.js';
import { declaredWriteRoot, resolveSafeOutputPath } from './security.js';
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
                    resultMode: {
                        type: 'string',
                        enum: ['metadata', 'schema', 'body'],
                        description: '默认 metadata；schema 只返回 body 结构；body 仅可在 ruyi_intercept_wait 写入本地 JSONL。',
                        default: 'metadata',
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
                resultMode: args.resultMode ?? 'metadata',
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
                    resultMode: {
                        type: 'string',
                        enum: ['metadata', 'schema', 'body'],
                        description: '默认 metadata；schema 只返回 body 结构；body 仅可在 ruyi_intercept_wait 写入本地 JSONL。',
                        default: 'metadata',
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
                resultMode: args.resultMode ?? 'metadata',
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
                'Bridge 会在取样后立即 continue，避免 MCP 把浏览器请求永久卡住。' +
                '默认只返回脱敏 metadata；body 只会写入显式指定的本地 JSONL 文件。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    timeout: { type: 'number', description: '等待超时（秒），默认 10', default: 10 },
                    resultMode: {
                        type: 'string',
                        enum: ['metadata', 'schema', 'body'],
                        description: '不传时沿用 start 模式；schema/body 必须在 start 时已启用 collector，不能由 metadata 会话事后升级。',
                    },
                    bodyReadTimeout: {
                        type: 'number',
                        description: 'schema/body 读取单个 body 的最多等待秒数，默认 1，范围 0–10。',
                        minimum: 0,
                        maximum: 10,
                        default: 1,
                    },
                    outputFile: {
                        type: 'string',
                        description: 'resultMode=body 时必填的绝对 JSONL 文件路径（拒绝相对路径、.. 段、UNC 与根目录直写；如配置 RUYI_MCP_WORKSPACE_ROOT 则路径必须位于其下）。',
                    },
                    maxBodyChars: {
                        type: 'number',
                        description: '仅 resultMode=body 的本地 JSONL body 字符上限；0 表示不截断。',
                        minimum: 0,
                        default: 0,
                    },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            if (args.resultMode === 'body' && !args.outputFile) {
                throw new Error('outputFile is required when resultMode=body');
            }
            let safeOutputFile;
            if (args.outputFile !== undefined) {
                const pathCheck = resolveSafeOutputPath(args.outputFile, 'outputFile', 'file', declaredWriteRoot(args));
                if (!pathCheck.ok) {
                    throw new Error(`${pathCheck.errorCode}: ${pathCheck.errorMessage}`);
                }
                safeOutputFile = pathCheck.resolved;
            }
            const result = await ctx.bridgeInstance.call('intercept.wait', {
                pageIdx,
                timeout: args.timeout ?? 10,
                resultMode: args.resultMode,
                bodyReadTimeout: args.bodyReadTimeout ?? 1,
                outputFile: safeOutputFile,
                maxBodyChars: args.maxBodyChars ?? 0,
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