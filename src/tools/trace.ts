/**
 * Fingerprint trace tools: trace_start, trace_stop, trace_get_results.
 * ruyi unique — ruyitrace DOM API tracing integration.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerTraceTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_trace_start
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_trace_start',
      description:
        '⚠ BiDi trace 必须在 ruyi_new_page 时通过 traceEnabled:true 参数启用。' +
        '浏览器启动后调用此工具仅记录追加的 BiDi 事件。' +
        '如需完整 trace，请 ruyi_browser_quit 后用 traceEnabled:true 重新 ruyi_new_page。' +
        '当前 trace 记录 BiDi 协议级事件（非 DOM API 级别）。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          outputFile: { type: 'string', description: '停止追踪后保存到的 NDJSON/JSON 文件路径' },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('trace.start', {
        pageIdx,
        outputFile: args.outputFile,
      }) as Record<string, unknown>;

      ctx.setTraceEnabled(result.tracing === true);

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_trace_stop
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_trace_stop',
      description: '停止 BiDi 追踪并返回结果摘要和数据。',
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
      const result = await ctx.bridgeInstance.call('trace.stop', { pageIdx }) as Record<string, unknown>;

      ctx.setTraceEnabled(false);

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_trace_get_results
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_trace_get_results',
      description: '获取当前的追踪结果（不停止追踪）。返回最近的 BiDi 事件条目。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          limit: { type: 'number', description: '最大返回条数，默认 50', default: 50 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('trace.results', {
        pageIdx,
        limit: args.limit ?? 50,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
