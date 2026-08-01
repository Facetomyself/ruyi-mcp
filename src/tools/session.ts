/**
 * Canonical browser-session handoff for the reverse_ENV evidence plane.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerSessionTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_export_session
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_export_session',
      description:
        '导出 browser-session-handoff.v1。默认仅导出 Cookie；Storage 只有显式请求时才作为 observation-only evidence 写盘，' +
        'RuyiTrace v1 不支持 Storage import。MCP 响应仅返回带 evidence-pointer.v1 的脱敏 handoff。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '标签页索引', default: 0 },
          caseId: {
            type: 'string',
            description: 'Web reverse case ID，需匹配 ^[a-z0-9][a-z0-9._-]{1,79}$。',
            pattern: '^[a-z0-9][a-z0-9._-]{1,79}$',
          },
          handoffId: {
            type: 'string',
            description: '可选 handoff ID；未提供时自动生成。',
            pattern: '^[a-z0-9][a-z0-9_-]{0,95}$',
          },
          workspaceRoot: {
            type: 'string',
            description: '当前项目 workspace 根目录的绝对路径；状态文件固定写入 evidence/web/handoff/<handoffId>。',
          },
          browserPath: {
            type: 'string',
            description: 'Firefox 可执行文件绝对路径；attach 模式无法自动发现时必填，用于版本、BuildID 与 SHA-256 校验。',
          },
          include: {
            type: 'array',
            description: '要写入 evidence 文件的浏览器状态。默认仅 Cookie；Storage 需显式请求且仅供观察，consumer 不支持导入。原值不会 inline 返回。',
            items: { type: 'string', enum: ['cookies', 'storage'] },
            minItems: 1,
            uniqueItems: true,
            default: ['cookies'],
          },
        },
        required: ['caseId', 'workspaceRoot'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('session.export', {
        pageIdx,
        caseId: args.caseId,
        handoffId: args.handoffId,
        workspaceRoot: args.workspaceRoot,
        browserPath: args.browserPath,
        include: args.include ?? ['cookies'],
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
