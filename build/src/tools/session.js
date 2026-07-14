/**
 * Session export tool: export_session.
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerSessionTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_export_session
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_export_session',
            description: '导出当前浏览器会话状态（Cookie、localStorage、sessionStorage、UserAgent、URL）。' +
                '可保存到 JSON 文件供 js-reverse-mcp、ruyitrace 或其他工具复用。' +
                '这是跨工具 session 桥接的核心工具。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', description: '标签页索引', default: 0 },
                    outputFile: {
                        type: 'string',
                        description: '保存到的 JSON 文件路径（绝对路径）。不提供则直接返回内容。',
                    },
                    include: {
                        type: 'array',
                        description: '要导出的内容类型',
                        items: { type: 'string' },
                        default: ['cookies', 'localStorage', 'sessionStorage'],
                    },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('session.export', {
                pageIdx,
                outputFile: args.outputFile,
                include: args.include ?? ['cookies', 'localStorage', 'sessionStorage'],
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
}
//# sourceMappingURL=session.js.map