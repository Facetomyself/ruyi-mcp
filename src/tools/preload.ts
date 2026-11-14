import type { RuyiContext } from '../ruyi-context.js';
import { getPageIdx, type ToolRegistrar } from './types.js';

export function registerPreloadTools(register: ToolRegistrar, ctx: RuyiContext): void {
  register({
    tool: {
      name: 'ruyi_list_preload_scripts',
      description: '列出本会话已安装的 BiDi preload 脚本。',
      inputSchema: { type: 'object', properties: { pageIdx: { type: 'integer', minimum: 0 } } },
    },
    handler: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(
      await ctx.bridgeInstance.call('script.list_preloads', { pageIdx: getPageIdx(args, ctx) })
    ) }] }),
  });
}
