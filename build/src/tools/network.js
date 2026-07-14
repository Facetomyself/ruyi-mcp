/**
 * Network forensics tools: list_network_requests, capture_start, capture_stop, capture_wait.
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerNetworkTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_list_network_requests
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_list_network_requests',
            description: '列出最近的网络请求。基于 performance API 获取资源加载信息。' +
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
            const urlFilter = args.urlFilter || '';
            const limit = args.limit ?? 50;
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
            const result = await ctx.bridgeInstance.call('script.evaluate', { pageIdx, script });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_capture_start
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_capture_start',
            description: '开始被动抓包。按 URL 模式匹配请求，后续用 ruyi_capture_wait 获取。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    pattern: { type: 'string', description: 'URL 匹配模式（子串匹配）', default: '' },
                    method: { type: 'string', description: '仅匹配 HTTP 方法（GET/POST/...）' },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const pattern = args.pattern || '';
            await ctx.bridgeInstance.call('network.capture_start', {
                pageIdx,
                pattern,
                method: args.method,
            });
            ctx.setCaptureActive(true, pattern);
            return {
                content: [{ type: 'text', text: jsonResult({ capturing: true, pattern }) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_capture_stop
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_capture_stop',
            description: '停止被动抓包。',
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
            await ctx.bridgeInstance.call('network.capture_stop', { pageIdx });
            ctx.setCaptureActive(false);
            return {
                content: [{ type: 'text', text: jsonResult({ capturing: false }) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_capture_wait
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_capture_wait',
            description: '等待并获取抓包结果。在调用 ruyi_capture_start 后使用。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    timeout: { type: 'number', description: '等待超时（秒），默认 10', default: 10 },
                    count: { type: 'number', description: '期望捕获的请求数，默认 5', default: 5 },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('network.capture_wait', {
                pageIdx,
                timeout: args.timeout ?? 10,
                count: args.count ?? 5,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_get_request_initiator
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_get_request_initiator',
            description: '注入 fetch/XHR Proxy 以捕获后续 JS 请求的调用栈。' +
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
            const result = await ctx.bridgeInstance.call('script.evaluate', { pageIdx, script });
            // Read collected initiators
            const collect = await ctx.bridgeInstance.call('script.evaluate', {
                pageIdx,
                script: '() => { const r = window.__ruyi_initiator_requests || []; return r.slice(-20); }',
                timeout: 5,
            });
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
        }),
    });
}
//# sourceMappingURL=network.js.map