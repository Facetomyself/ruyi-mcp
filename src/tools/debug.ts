/**
 * Debug tools: set_breakpoint_on_text, break_on_xhr, list_breakpoints, remove_breakpoint.
 *
 * Note: Full CDP-style debugging (step, pause, get_paused_info) is not available
 * via WebDriver BiDi in the current Firefox. Instead we use soft breakpoints:
 * preload scripts that inject debugger; statements or Proxy wrappers around
 * XMLHttpRequest/Fetch.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';
import type { BreakpointInfo } from '../ruyi-context.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerDebugTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_set_breakpoint_on_text
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_set_breakpoint_on_text',
      description:
        '设置软断点（通过 preload script 注入 debugger 或 Proxy 包装）。' +
        '支持 XHR/Fetch URL 断点和函数名匹配。' +
        '⚠ 当前 BiDi 不支持完整的 CDP 式断点调试，此工具注入 debugger; 语句作为替代。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要匹配的代码文本、URL 片段或函数名。' },
          urlFilter: { type: 'string', description: '仅在 URL 匹配的脚本中注入' },
          pageIdx: { type: 'number', default: 0 },
          condition: { type: 'string', description: '断点条件（暂不支持，保留参数兼容性）' },
        },
        required: ['text'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const text = args.text as string;
      const urlFilter = args.urlFilter as string || '';

      const result = await ctx.bridgeInstance.call('debug.set_breakpoint', {
        pageIdx,
        mode: 'text',
        text,
        urlFilter,
      }) as Record<string, unknown>;

      ctx.addBreakpoint({
        breakpointId: result.breakpointId as string,
        text,
        mode: 'text',
        urlFilter,
        type: 'soft',
      });

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_break_on_xhr
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_break_on_xhr',
      description:
        '在 XHR/Fetch 请求 URL 匹配时触发断点（注入 debugger）。' +
        '等价于 ruyi_set_breakpoint_on_text with XHR wrapper.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL 匹配片段（子串匹配）' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['url'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const url = args.url as string;

      const result = await ctx.bridgeInstance.call('debug.set_breakpoint', {
        pageIdx,
        mode: 'xhr',
        pattern: url,
        text: `xhr:${url}`,
        urlFilter: '',
      }) as Record<string, unknown>;

      ctx.addBreakpoint({
        breakpointId: result.breakpointId as string,
        text: `xhr:${url}`,
        mode: 'xhr',
        pattern: url,
        type: 'soft',
      });

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_list_breakpoints
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_list_breakpoints',
      description: '列出当前所有活跃的软断点。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: (async () => {
      return {
        content: [{ type: 'text', text: jsonResult({ breakpoints: ctx.getBreakpoints() }) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_remove_breakpoint
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_remove_breakpoint',
      description: '移除指定软断点。',
      inputSchema: {
        type: 'object',
        properties: {
          breakpointId: { type: 'string', description: '断点 ID（来自 ruyi_list_breakpoints）' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['breakpointId'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const bpId = args.breakpointId as string;

      await ctx.bridgeInstance.call('debug.remove_breakpoint', {
        pageIdx,
        breakpointId: bpId,
      });

      ctx.removeBreakpoint(bpId);

      return {
        content: [{ type: 'text', text: jsonResult({ removed: bpId }) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_list_preload_scripts
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_list_preload_scripts',
      description: '列出所有已注入的 preload 脚本。每个脚本有 scriptId 和内容摘要。',
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
      const result = await ctx.bridgeInstance.call('script.list_preloads', { pageIdx }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
