import { getPageIdx } from './types.js';
export function registerTraceTools(register, ctx) {
    for (const action of ['start', 'stop', 'get_results']) {
        for (const legacy of [false, true]) {
            const name = `ruyi_${legacy ? '' : 'bidi_'}trace_${action}`;
            register({
                tool: {
                    name,
                    description: `${legacy ? 'Deprecated alias：请使用 ruyi_bidi_trace_*。' : ''}浏览器级 BiDi 命令、事件与错误时间线；所有 tab 共享缓冲，不是页面 JS trace 或 C++ DOMTrace。${action === 'stop' ? '停止并返回摘要；完整数据按显式路径保存。' : action === 'start' ? '开始记录，可指定停止时输出路径。' : '读取有界最近记录。'}`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            pageIdx: { type: 'integer', minimum: 0 },
                            ...(action === 'start' ? { outputFile: { type: 'string', description: '完整 JSON 输出的绝对路径' } } : {}),
                            ...(action === 'get_results' ? { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } : {}),
                        },
                    },
                },
                handler: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await ctx.bridgeInstance.call(`bidi_trace.${action === 'get_results' ? 'results' : action}`, { ...args, pageIdx: getPageIdx(args, ctx) })) }] }),
            });
        }
    }
}
//# sourceMappingURL=trace.js.map