/**
 * Native Firefox download behavior configuration via WebDriver BiDi.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolHandler, ToolRegistrar, getPageIdx } from './types.js';
import { declaredWriteRoot, resolveSafeOutputPath } from './security.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerDownloadTools(register: ToolRegistrar, ctx: RuyiContext): void {
  register({
    tool: {
      name: 'ruyi_set_download_behavior',
      description:
        '通过 Firefox WebDriver BiDi 配置原生下载策略。allow 会将下载直接保存到绝对目录，' +
        '无需 Firefox 保存确认；deny 会阻止下载。只控制本地浏览器，不影响站点授权或访问控制。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '用于定位当前 Firefox 会话的标签页索引，默认当前活跃页', default: 0 },
          behavior: {
            type: 'string',
            description: '下载策略',
            enum: ['allow', 'deny'],
          },
          downloadPath: {
            type: 'string',
            description:
              'allow 时必填的本地绝对下载目录（拒绝相对路径、.. 段、UNC 与根目录直写；如配置 RUYI_MCP_WORKSPACE_ROOT 则路径必须位于其下）；Bridge 会创建该目录。',
          },
          userContexts: {
            type: 'array',
            description: '可选 Firefox container user context ID 列表；省略则作用于当前浏览器全部 context。',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
        required: ['behavior'],
      },
    },
    handler: (async (args) => {
      const behavior = args.behavior as string;
      if (behavior === 'allow' && (typeof args.downloadPath !== 'string' || !args.downloadPath.trim())) {
        throw new Error('downloadPath is required when behavior is allow');
      }
      if (behavior === 'deny' && args.downloadPath !== undefined) {
        throw new Error('downloadPath is only valid when behavior is allow');
      }

      let safeDownloadPath: string | undefined;
      if (behavior === 'allow') {
        const pathCheck = resolveSafeOutputPath(
          args.downloadPath,
          'downloadPath',
          'directory',
          declaredWriteRoot(args)
        );
        if (!pathCheck.ok) {
          throw new Error(`${pathCheck.errorCode}: ${pathCheck.errorMessage}`);
        }
        safeDownloadPath = pathCheck.resolved;
      }

      const result = await ctx.bridgeInstance.call('download.set_behavior', {
        pageIdx: getPageIdx(args, ctx),
        behavior,
        downloadPath: safeDownloadPath,
        userContexts: args.userContexts,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
