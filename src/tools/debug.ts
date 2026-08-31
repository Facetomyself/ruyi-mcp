/**
 * Native Firefox debugger tools via page.debugger (DevTools RDP).
 *
 * Breakpoints are planted by the debugger itself at source URL/line.
 * Preload `debugger;` injection is not used.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';
import type { BreakpointInfo } from '../ruyi-context.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object') ? value as Record<string, unknown> : {};
}

function recordBreakpoint(ctx: RuyiContext, result: Record<string, unknown>, fallback: Partial<BreakpointInfo> = {}): void {
  const breakpointId = result.breakpointId as string | undefined;
  if (!breakpointId) {
    return;
  }
  ctx.addBreakpoint({
    breakpointId,
    text: String(result.text ?? fallback.text ?? ''),
    mode: (result.mode as BreakpointInfo['mode']) ?? fallback.mode ?? 'location',
    pattern: (result.pattern as string | undefined) ?? fallback.pattern,
    urlFilter: (result.url as string | undefined) ?? fallback.urlFilter,
    condition: (result.condition as string | undefined) ?? fallback.condition,
    type: 'native',
    pageIdx: (result.pageIdx as number | undefined) ?? fallback.pageIdx,
    url: result.url as string | undefined,
    sourceActor: result.sourceActor as string | undefined,
    line: result.line as number | undefined,
    column: result.column as number | undefined,
  });
}

export function registerDebugTools(register: ToolRegistrar, ctx: RuyiContext): void {

  register({
    tool: {
      name: 'ruyi_debug_enable',
      description:
        '连接 Firefox DevTools RDP 并 attach 当前标签页的 thread actor。' +
        '必须在 ruyi_new_page 时传入 enableDebugger=true（启动 --start-debugger-server）。' +
        'debug toolset 默认会在 launch 时打开。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          debuggerPort: {
            type: 'number',
            description: '已有 RDP 端口；attach 会话必填',
            minimum: 1,
            maximum: 65535,
          },
          autoResumeAfter: {
            type: 'number',
            description: '暂停看门狗秒数，超时自动 resume，避免 JS 永久卡住。默认 60；0 表示关闭。',
            minimum: 0,
            maximum: 3600,
          },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.enable', {
        pageIdx: getPageIdx(args, ctx),
        debuggerPort: args.debuggerPort,
        autoResumeAfter: args.autoResumeAfter,
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_disable',
      description: '断开所有页面的 debugger RDP 通道并清理 native 断点。若当前已暂停则先 resume，避免页面卡死。',
      inputSchema: {
        type: 'object',
        properties: { pageIdx: { type: 'number', default: 0 } },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.disable', {
        pageIdx: getPageIdx(args, ctx),
      });
      ctx.clearBreakpoints();
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_status',
      description: '查询 debugger 是否已启动、是否暂停、以及当前暂停快照。',
      inputSchema: {
        type: 'object',
        properties: { pageIdx: { type: 'number', default: 0 } },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.status', {
        pageIdx: getPageIdx(args, ctx),
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_list_sources',
      description: '列出 JS 引擎已加载的源（含内联 script、blob、eval）。这是 debugger 源表，不是 DOM script[src]。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          urlContains: { type: 'string', description: '只返回 URL 含该子串的源' },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.sources', {
        pageIdx: getPageIdx(args, ctx),
        urlContains: args.urlContains,
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_set_breakpoint',
      description:
        '在指定源 URL 或 sourceActor 的指定行下原生断点（debugger 自己下端点）。' +
        '行号从 1 开始；省略 column 时自动取该行第一个可断点列。' +
        'condition 为真才暂停；条件抛异常仍会暂停（why=breakpointConditionThrown）。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '源 URL，需与 ruyi_debug_list_sources 一致，可用后缀匹配' },
          sourceActor: { type: 'string', description: '无 URL 的 eval/blob/inline source actor（与 url 二选一）' },
          line: { type: 'number', description: '行号，从 1 开始', minimum: 1 },
          column: { type: 'number', description: '列号；省略则自动解析', minimum: 0 },
          condition: { type: 'string', description: '条件表达式，在断点所在帧求值' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['line'],
        oneOf: [{ required: ['url', 'line'] }, { required: ['sourceActor', 'line'] }],
      },
    },
    handler: (async (args) => {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const sourceActor = typeof args.sourceActor === 'string' ? args.sourceActor.trim() : '';
      if (Boolean(url) === Boolean(sourceActor)) {
        throw new Error('Exactly one of url or sourceActor is required');
      }
      const result = asRecord(await ctx.bridgeInstance.call('debug.set_breakpoint', {
        pageIdx: getPageIdx(args, ctx),
        url: url || undefined,
        sourceActor: sourceActor || undefined,
        line: args.line,
        column: args.column,
        condition: args.condition,
      }));
      recordBreakpoint(ctx, result, { mode: 'location', urlFilter: url || undefined });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_set_breakpoint_on_text',
      description:
        '在已加载源码中搜索文本并下原生断点。不再注入 debugger;。' +
        '默认自动化 toolset 不暴露此工具。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要匹配的源码文本' },
          urlFilter: { type: 'string', description: '仅搜索 URL 含该子串的源' },
          sourceActor: { type: 'string', description: '仅搜索指定 source actor（适用于 eval/blob/inline）' },
          pageIdx: { type: 'number', default: 0 },
          condition: { type: 'string', description: '断点条件表达式' },
        },
        required: ['text'],
      },
    },
    handler: (async (args) => {
      const result = asRecord(await ctx.bridgeInstance.call('debug.set_breakpoint_on_text', {
        pageIdx: getPageIdx(args, ctx),
        text: args.text,
        urlFilter: args.urlFilter,
        sourceActor: args.sourceActor,
        condition: args.condition,
      }));
      recordBreakpoint(ctx, result, { mode: 'text', text: args.text as string });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_break_on_xhr',
      description:
        '优先使用 Firefox RDP 原生 XHR breakpoint；旧版 ruyiPage 无该 API 时回退为显式标记的源码启发式，' +
        '不会注入 debugger;，也不会冒充 verified request initiator。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL 匹配片段' },
          method: { type: 'string', description: '请求方法；默认 ANY', default: 'ANY' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['url'],
      },
    },
    handler: (async (args) => {
      const result = asRecord(await ctx.bridgeInstance.call('debug.break_on_xhr', {
        pageIdx: getPageIdx(args, ctx),
        url: args.url,
        method: args.method,
      }));
      const planted = Array.isArray(result.breakpoints) ? result.breakpoints : [];
      for (const item of planted) {
        recordBreakpoint(ctx, asRecord(item), { mode: 'xhr', pattern: args.url as string });
      }
      return {
        content: [{ type: 'text', text: jsonResult(result) }],
        isError: result.ok === false || undefined,
      };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_list_breakpoints',
      description: '列出当前 debugger 原生断点。',
      inputSchema: {
        type: 'object',
        properties: { pageIdx: { type: 'number', description: '仅列出指定标签页的断点' } },
        required: [],
      },
    },
    handler: (async (args) => {
      const params: Record<string, unknown> = {};
      if (args.pageIdx !== undefined) {
        params.pageIdx = getPageIdx(args, ctx);
      }
      const result = await ctx.bridgeInstance.call('debug.list_breakpoints', params);
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_remove_breakpoint',
      description: '移除指定原生断点。',
      inputSchema: {
        type: 'object',
        properties: {
          breakpointId: { type: 'string', description: '断点 ID' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['breakpointId'],
      },
    },
    handler: (async (args) => {
      const bpId = args.breakpointId as string;
      const params: Record<string, unknown> = {
        breakpointId: bpId,
      };
      // Omit pageIdx when the caller only has the breakpoint id; the Bridge
      // can then route to the owning debugger instead of assuming page 0.
      if (args.pageIdx !== undefined) {
        params.pageIdx = getPageIdx(args, ctx);
      }
      const result = await ctx.bridgeInstance.call('debug.remove_breakpoint', params);
      ctx.removeBreakpoint(bpId);
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_wait_paused',
      description: '等待下一次暂停。触发断点的 BiDi/点击必须放在其他调用里，暂停期间不要 run_js。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          timeout: {
            type: 'number',
            description: '秒，默认 30；0 表示立即轮询',
            default: 30,
            minimum: 0,
            maximum: 120,
          },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.wait_paused', {
        pageIdx: getPageIdx(args, ctx),
        timeout: args.timeout ?? 30,
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_get_paused_info',
      description: '读取当前暂停快照与有界调用栈。未暂停时 paused=false。',
      inputSchema: {
        type: 'object',
        properties: { pageIdx: { type: 'number', default: 0 } },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.get_paused_info', {
        pageIdx: getPageIdx(args, ctx),
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_pause',
      description: '立即暂停 JS 执行。',
      inputSchema: {
        type: 'object',
        properties: { pageIdx: { type: 'number', default: 0 } },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.pause', {
        pageIdx: getPageIdx(args, ctx),
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_resume',
      description: '从当前暂停恢复执行。',
      inputSchema: {
        type: 'object',
        properties: { pageIdx: { type: 'number', default: 0 } },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.resume', {
        pageIdx: getPageIdx(args, ctx),
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_step',
      description: '单步：over 跳过、into 进入、out 跳出。只能在暂停状态下调用。',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['over', 'into', 'out'], default: 'over' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.step', {
        pageIdx: getPageIdx(args, ctx),
        type: args.type ?? 'over',
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_get_frames',
      description: '读取当前调用栈。只能在暂停状态下调用。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          count: { type: 'number', description: '最多帧数，默认 50', default: 50 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.frames', {
        pageIdx: getPageIdx(args, ctx),
        count: args.count ?? 50,
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_get_scopes',
      description:
        '读取某一帧的作用域变量（默认到函数边界，不含全局）。' +
        '对象以 remoteObject actor 返回，用 ruyi_debug_expand_object 展开。只能在暂停时调用。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          frameActor: { type: 'string', description: 'frame actor；默认当前暂停帧' },
          includeParents: { type: 'boolean', description: '包含闭包与全局', default: false },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.scope', {
        pageIdx: getPageIdx(args, ctx),
        frameActor: args.frameActor,
        includeParents: args.includeParents,
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_expand_object',
      description: '按 actor 展开暂停现场中的对象，突破 preview 上限。只能在暂停时调用。',
      inputSchema: {
        type: 'object',
        properties: {
          actor: { type: 'string', description: 'RemoteObject actor id' },
          pageIdx: { type: 'number', default: 0 },
          depth: { type: 'number', default: 1 },
          maxItems: { type: 'number', default: 80 },
        },
        required: ['actor'],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.expand', {
        pageIdx: getPageIdx(args, ctx),
        actor: args.actor,
        depth: args.depth ?? 1,
        maxItems: args.maxItems ?? 80,
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_debug_pause_on_exception',
      description: '异常抛出时自动暂停。默认忽略会被 catch 接住的异常。',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: true },
          ignoreCaught: { type: 'boolean', default: true },
          pageIdx: { type: 'number', default: 0 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const result = await ctx.bridgeInstance.call('debug.pause_on_exceptions', {
        pageIdx: getPageIdx(args, ctx),
        enabled: args.enabled ?? true,
        ignoreCaught: args.ignoreCaught ?? true,
      });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });

  register({
    tool: {
      name: 'ruyi_list_preload_scripts',
      description: '列出所有已注入的 preload 脚本。每个脚本有 scriptId 和内容摘要。',
      inputSchema: {
        type: 'object',
        properties: { pageIdx: { type: 'number', default: 0 } },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('script.list_preloads', { pageIdx });
      return { content: [{ type: 'text', text: jsonResult(result) }] };
    }) as ToolHandler,
  });
}
