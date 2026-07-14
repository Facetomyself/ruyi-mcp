/**
 * BiDi trace tools: trace_start, trace_stop, trace_get_results.
 * These expose ruyipage's structured in-memory tracer, not kernel DOMTrace.
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
        '从当前时刻开始记录结构化 BiDi trace；首次在运行中的浏览器上启动时，会清空旧缓冲区并建立新的 trace 段。' +
        '浏览器启动时已开启或重复调用时会保留现有缓冲区。' +
        '浏览器启动后调用也会真实启用记录，但不包含此前的启动事件。' +
        '如需覆盖启动阶段，请在 ruyi_new_page 时设置 traceEnabled:true。' +
        '该工具记录 BiDi 协议级事件，不等同于 Firefox 内核 DOMTrace。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          outputFile: { type: 'string', description: '停止追踪后保存到的 JSON 文件路径' },
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
