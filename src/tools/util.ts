/**
 * Utility tools: take_screenshot, clear_site_data, browser_status.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';
import { declaredWriteRoot, resolveSafeOutputPath } from './security.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerUtilTools(register: ToolRegistrar, ctx: RuyiContext): void {

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
          filePath: {
            type: 'string',
            description:
              '保存路径（PNG，绝对路径；拒绝相对路径、.. 段、UNC 与根目录直写；如配置 RUYI_MCP_WORKSPACE_ROOT 则路径必须位于其下）。不提供则返回 base64。',
          },
          fullPage: { type: 'boolean', description: '是否截取整页（默认仅视口）', default: false },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const filePath = args.filePath as string | undefined;
      let safeFilePath: string | undefined;
      if (filePath !== undefined) {
        const pathCheck = resolveSafeOutputPath(filePath, 'filePath', 'file', declaredWriteRoot(args));
        if (!pathCheck.ok) {
          return {
            content: [{
              type: 'text',
              text: jsonResult({
                error: {
                  code: pathCheck.errorCode,
                  message: pathCheck.errorMessage,
                  field: 'filePath',
                },
              }),
            }],
            isError: true,
          };
        }
        safeFilePath = pathCheck.resolved;
      }
      const result = await ctx.bridgeInstance.call('page.screenshot', {
        pageIdx,
        filePath: safeFilePath,
        fullPage: args.fullPage ?? false,
      }) as Record<string, unknown>;

      if (result.base64) {
        return {
          content: [
            { type: 'image', data: result.base64 as string, mimeType: 'image/png' },
            { type: 'text', text: jsonResult({ screenshot: true }) },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
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
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_browser_status
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_browser_status',
      description: '读取当前浏览器状态；借用 Trace 时以 controlAvailable 判断是否有控制权，leaseState 区分 active、revoked、unknown，alive 仅表示 owner 就绪。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: (async () => {
      const result = await ctx.status();

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_browser_quit
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_browser_quit',
      description: '关闭 MCP 自启浏览器；外部浏览器只断开。借用 Trace 时仅归还租约，effect 区分 lease_released 与 lease_already_lost，浏览器仍由 Trace 管理。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: (async () => {
      const result = await ctx.quit();

      return {
        content: [{ type: 'text', text: jsonResult(result ?? { quit: true }) }],
      };
    }) as ToolHandler,
  });
}
