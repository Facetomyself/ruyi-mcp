/**
 * Utility tools: take_screenshot, clear_site_data, browser_status.
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerUtilTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_take_screenshot
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_take_screenshot',
            description: '对当前页面截图。可保存到文件或返回 base64 编码（PNG）。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    filePath: { type: 'string', description: '保存路径（PNG）。不提供则返回 base64。' },
                    fullPage: { type: 'boolean', description: '是否截取整页（默认仅视口）', default: false },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('page.screenshot', {
                pageIdx,
                filePath: args.filePath,
                fullPage: args.fullPage ?? false,
            });
            if (result.base64) {
                return {
                    content: [
                        { type: 'image', data: result.base64, mimeType: 'image/png' },
                        { type: 'text', text: jsonResult({ screenshot: true }) },
                    ],
                };
            }
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_clear_site_data
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_clear_site_data',
            description: '清除当前页面的浏览器状态：Cookie、localStorage、sessionStorage。',
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
            await ctx.bridgeInstance.call('page.clear_data', { pageIdx });
            return {
                content: [{ type: 'text', text: jsonResult({ cleared: true }) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_browser_status
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_browser_status',
            description: '获取浏览器当前状态：是否存活、当前 URL、页面数量、断点数、preload 脚本数。',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        handler: (async () => {
            const result = await ctx.bridgeInstance.call('browser.status');
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_browser_quit
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_browser_quit',
            description: '关闭浏览器并清理所有会话状态。',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        handler: (async () => {
            await ctx.quit();
            return {
                content: [{ type: 'text', text: jsonResult({ quit: true }) }],
            };
        }),
    });
}
//# sourceMappingURL=util.js.map