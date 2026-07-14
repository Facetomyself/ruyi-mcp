/**
 * Runtime evaluation tools: evaluate_script, list_console_messages.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerRuntimeTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_evaluate_script
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_evaluate_script',
      description:
        '在浏览器页面中执行 JavaScript 函数并返回结果。' +
        '可用于运行时采样、Hook 注入、读取页面状态。' +
        '函数必须返回 JSON-safe 值。支持接收本地文件作为参数。',
      inputSchema: {
        type: 'object',
        properties: {
          function: {
            type: 'string',
            description:
              '要执行的 JavaScript 函数声明。' +
              '例: "() => { return document.title }" 或 "async () => { return await fetch(\'example.com\') }"',
          },
          pageIdx: { type: 'number', description: '标签页索引，默认当前活跃页', default: 0 },
          timeout: { type: 'number', description: '超时（秒），默认 10', default: 10 },
          sandbox: { type: 'string', description: 'BiDi sandbox 名称（隔离执行上下文）' },
        },
        required: ['function'],
      },
    },
    handler: (async (args) => {
      const fn = args.function as string;
      const pageIdx = getPageIdx(args, ctx);
      const timeout = (args.timeout as number | undefined) ?? 10;

      // Clean up arrow function wrapper if user passed raw code
      let script = fn.trim();
      // If it's already an arrow function, use as-is
      // Otherwise, wrap in arrow function
      if (!script.startsWith('(') && !script.startsWith('async') && !script.startsWith('function')) {
        script = `() => { ${script} }`;
      }

      const result = await ctx.bridgeInstance.call('script.evaluate', {
        pageIdx,
        script,
        timeout,
        sandbox: args.sandbox,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_list_console_messages
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_list_console_messages',
      description: '读取浏览器控制台日志消息。支持按类型筛选。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '标签页索引', default: 0 },
          types: {
            type: 'array',
            description: '筛选消息类型：log, debug, info, error, warn',
          },
          limit: { type: 'number', description: '最大返回条数，默认 50', default: 50 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('console.get', {
        pageIdx,
        types: args.types,
        limit: args.limit ?? 50,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
