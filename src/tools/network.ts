/**
 * Network forensics tools: list_network_requests, capture_start, capture_stop, capture_wait.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerNetworkTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_list_network_requests
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_list_network_requests',
      description:
        '列出最近的网络请求。基于 performance API 获取资源加载信息。' +
        '需要更详细信息时，使用 ruyi_capture_start 主动抓包。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          urlFilter: { type: 'string', description: 'URL 筛选字符串' },
          limit: { type: 'number', description: '最大结果数，默认 50', default: 50 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const urlFilter = args.urlFilter as string || '';
      const limit = (args.limit as number | undefined) ?? 50;

      const script = `() => {
        let entries = performance.getEntriesByType('resource');
        if (${JSON.stringify(urlFilter)}) {
          const f = ${JSON.stringify(urlFilter)}.toLowerCase();
          entries = entries.filter(e => e.name.toLowerCase().includes(f));
        }
        return entries.slice(-${limit}).map(e => ({
          name: e.name,
          initiatorType: e.initiatorType,
          duration: Math.round(e.duration),
          transferSize: e.transferSize,
          startTime: Math.round(e.startTime),
        }));
      }`;

      const result = await ctx.bridgeInstance.call('script.evaluate', { pageIdx, script }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_capture_start
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_capture_start',
      description:
        '开始被动抓包。默认只收集脱敏 metadata，不申请 body DataCollector；' +
        '需要字段结构或原始 body 时显式设置 resultMode。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          pattern: { type: 'string', description: 'URL 匹配模式（子串匹配）', default: '' },
          method: { type: 'string', description: '仅匹配 HTTP 方法（GET/POST/...）' },
          resultMode: {
            type: 'string',
            enum: ['metadata', 'schema', 'body'],
            description: '输出模式：metadata 默认；schema 只返回 body 结构、长度和 hash；body 仅写入 ruyi_capture_wait.outputFile。',
            default: 'metadata',
          },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const pattern = args.pattern as string || '';

      const result = await ctx.bridgeInstance.call('network.capture_start', {
        pageIdx,
        pattern,
        method: args.method,
        resultMode: args.resultMode ?? 'metadata',
      }) as Record<string, unknown>;

      if (result.capturing) {
        ctx.setCaptureActive(true, pattern);
      }

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_capture_stop
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_capture_stop',
      description:
        '停止被动抓包。会先清空尚未消费的队列/历史，避免 ruyiPage stop 隐式补读全部 body；' +
        'mode=metadata 可在清理前返回有上限的脱敏摘要，并报告 observed/returned/discarded 计数。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          cleanupTimeout: {
            type: 'number',
            description: '每个 BiDi 清理命令的超时秒数，默认 5，范围 0.1–30',
            minimum: 0.1,
            maximum: 30,
            default: 5,
          },
          mode: {
            type: 'string',
            enum: ['discard', 'metadata'],
            description: 'discard 默认直接清理；metadata 在清理前返回未消费 packet 的脱敏摘要。',
            default: 'discard',
          },
          metadataLimit: {
            type: 'number',
            description: 'mode=metadata 时最多返回的摘要数，默认 100，范围 0–1000。',
            minimum: 0,
            maximum: 1000,
            default: 100,
          },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const rawCleanupTimeout = Number(args.cleanupTimeout ?? 5);
      const cleanupTimeout = Number.isFinite(rawCleanupTimeout)
        ? Math.min(30, Math.max(0.1, rawCleanupTimeout))
        : 5;
      const bridgeTimeoutMs = Math.ceil(cleanupTimeout * 2 * 1000) + 5000;
      const result = await ctx.bridgeInstance.call(
        'network.capture_stop',
        {
          pageIdx,
          cleanupTimeout,
          mode: args.mode ?? 'discard',
          metadataLimit: args.metadataLimit ?? 100,
        },
        bridgeTimeoutMs
      ) as Record<string, unknown>;
      ctx.setCaptureActive(false);

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_capture_wait
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_capture_wait',
      description:
        '等待并获取抓包结果。在调用 ruyi_capture_start 后使用。' +
        '默认只返回脱敏 metadata；schema 只返回 body 字段结构、长度和 hash；' +
        'body 永不经过 MCP response，只会追加到指定的本地 JSONL 文件。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          timeout: { type: 'number', description: '等待超时（秒），默认 10', default: 10 },
          count: { type: 'number', description: '期望捕获的请求数，默认 5', default: 5 },
          resultMode: {
            type: 'string',
            enum: ['metadata', 'schema', 'body'],
            description: '不传时沿用 capture_start 的模式；schema/body 必须在 capture_start 时已启用 collector，不能由 metadata 会话事后升级。',
          },
          bodyReadTimeout: {
            type: 'number',
            description: 'schema/body 读取单个 body 的最多等待秒数，默认 1，范围 0–10。',
            minimum: 0,
            maximum: 10,
            default: 1,
          },
          outputFile: {
            type: 'string',
            description: 'resultMode=body 时必填的绝对 JSONL 文件路径；原始 body 只写该文件。',
          },
          maxBodyChars: {
            type: 'number',
            description: '仅 resultMode=body 的本地 JSONL body 字符上限；0 表示不截断，默认 0。',
            minimum: 0,
            default: 0,
          },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const rawTimeout = Number(args.timeout ?? 10);
      const rawCount = Number(args.count ?? 5);
      const rawMaxBodyChars = Number(args.maxBodyChars ?? 0);
      const timeout = Number.isFinite(rawTimeout) ? Math.max(0.05, rawTimeout) : 10;
      const requestedCount = Number.isFinite(rawCount)
        ? Math.min(10_000, Math.max(1, Math.floor(rawCount)))
        : 5;
      const maxBodyChars = Number.isFinite(rawMaxBodyChars)
        ? Math.max(0, Math.floor(rawMaxBodyChars))
        : 0;
      const resultMode = args.resultMode as string | undefined;
      const bodyReadTimeout = args.bodyReadTimeout ?? 1;
      const outputFile = args.outputFile as string | undefined;
      if (resultMode === 'body' && !outputFile) {
        throw new Error('outputFile is required when resultMode=body');
      }
      const deadline = Date.now() + timeout * 1000;
      const packets: unknown[] = [];
      let resolvedResultMode = resultMode;
      let appendedPackets = 0;
      let savedTo: unknown;

      // ruyiPage can spend a full global BiDi timeout hydrating every packet
      // when count is large. One packet per bridge RPC bounds the failure
      // domain and leaves the Firefox process available for port reattach.
      while (packets.length < requestedCount) {
        const remainingSeconds = Math.max(0.05, (deadline - Date.now()) / 1000);
        const result = await ctx.bridgeInstance.call('network.capture_wait', {
          pageIdx,
          timeout: remainingSeconds,
          count: 1,
          resultMode,
          bodyReadTimeout,
          outputFile,
          maxBodyChars,
        }) as {
          packets?: unknown[];
          resultMode?: string;
          appendedPackets?: number;
          savedTo?: unknown;
        };
        resolvedResultMode = result.resultMode ?? resolvedResultMode;
        appendedPackets += result.appendedPackets ?? 0;
        savedTo = result.savedTo ?? savedTo;
        const batch = result.packets || [];
        if (batch.length === 0) break;
        packets.push(...batch);
        if (Date.now() >= deadline) break;
      }

      const result = {
        packets,
        resultMode: resolvedResultMode ?? 'metadata',
        bodyReadTimeout,
        bodyLimitChars: resolvedResultMode === 'body' ? maxBodyChars : null,
        savedTo: savedTo ?? null,
        appendedPackets,
      };

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_get_request_initiator
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_get_request_initiator',
      description:
        '注入 fetch/XHR Proxy 以捕获后续 JS 请求的调用栈。' +
        '注入后通过 ruyi_list_network_requests 可看到带 initiator 的请求。' +
        '⚠ 只能捕获注入后发起的 JS 请求；调用栈为 Error().stack 字符串格式。',
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

      const script = `() => {
        if (window.__ruyi_initiator_injected) {
          return { injected: false, status: 'already_injected', buffered: (window.__ruyi_initiator_requests || []).length };
        }
        window.__ruyi_initiator_requests = window.__ruyi_initiator_requests || [];
        window.__ruyi_initiator_injected = true;

        const captureStack = (url) => {
          const stack = new Error().stack || '';
          return stack.split('\\n').slice(2, 8).join('\\n');
        };

        // Intercept fetch
        const _fetch = window.fetch;
        window.fetch = function(url, init) {
          const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
          const stack = captureStack(urlStr);
          window.__ruyi_initiator_requests.push({
            type: 'fetch', url: urlStr,
            method: (init && init.method) || (url && url.method) || 'GET',
            time: Date.now(), stack,
          });
          return _fetch.apply(this, arguments);
        };
        Object.defineProperty(window.fetch, 'name', { value: 'fetch', configurable: true });
        Object.defineProperty(window.fetch, 'length', { value: _fetch.length, configurable: true });

        // Intercept XMLHttpRequest
        const OrigXHR = window.XMLHttpRequest;
        const RuyiXHR = function() {
          const xhr = new OrigXHR();
          const origOpen = xhr.open;
          xhr.open = function(method, url) {
            const stack = captureStack(url);
            xhr.__ruyi_initiator_url = url;
            xhr.__ruyi_initiator_method = method;
            xhr.__ruyi_initiator_stack = stack;
            return origOpen.apply(this, arguments);
          };
          const origSend = xhr.send;
          xhr.send = function() {
            if (xhr.__ruyi_initiator_url) {
              window.__ruyi_initiator_requests.push({
                type: 'xhr', url: xhr.__ruyi_initiator_url,
                method: xhr.__ruyi_initiator_method || 'GET',
                time: Date.now(), stack: xhr.__ruyi_initiator_stack,
              });
            }
            return origSend.apply(this, arguments);
          };
          return xhr;
        };
        RuyiXHR.prototype = OrigXHR.prototype;
        Object.defineProperty(RuyiXHR.prototype, 'constructor', { value: OrigXHR, configurable: true });
        for (const key of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) {
          if (key in OrigXHR) Object.defineProperty(RuyiXHR, key, { value: OrigXHR[key], configurable: true });
        }
        window.XMLHttpRequest = RuyiXHR;

        return { injected: true };
      }`;

      const result = await ctx.bridgeInstance.call('script.evaluate', { pageIdx, script }) as Record<string, unknown>;

      // Read collected initiators
      const collect = await ctx.bridgeInstance.call('script.evaluate', {
        pageIdx,
        script: '() => { const r = window.__ruyi_initiator_requests || []; return r.slice(-20); }',
        timeout: 5,
      }) as Record<string, unknown>;

      return {
        content: [{
          type: 'text',
          text: jsonResult({
            injected: result,
            initiators: collect,
            note: 'Only requests issued after injection are captured. Call this tool again after triggering requests to read the buffer.',
          }),
        }],
      };
    }) as ToolHandler,
  });
}
