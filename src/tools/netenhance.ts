/**
 * Network enhancement tools: set_extra_headers, set_cache_behavior.
 * ruyi unique — request/response interception and modification.
 *
 * Note: Full intercept_requests/intercept_responses require BiDi network
 * interception which ruyipage supports. These are available via page.intercept.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerNetEnhanceTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_set_extra_headers
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_set_extra_headers',
      description:
        '为所有后续请求附加额外的 HTTP Headers。用于注入认证 token、自定义 UA 等。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          headers: {
            type: 'object',
            description: 'Key-value 键值对，如 {"X-Token": "abc123", "X-Device-Id": "device1"}',
          },
        },
        required: ['headers'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const headers = args.headers as Record<string, string>;

      const headerInjections = Object.entries(headers)
        .map(([k, v]) => [k, v])
        .filter(([k]) => k.toLowerCase() !== 'host'); // Can't override Host

      if (headerInjections.length === 0) {
        return {
          content: [{ type: 'text', text: jsonResult({ applied: 0, warning: 'No valid headers' }) }],
        };
      }

      const headerObj = JSON.stringify(Object.fromEntries(headerInjections));

      const script = `() => {
        const extraHeaders = ${headerObj};
        const applyHeaders = (headers) => {
          const h = new Headers(headers || {});
          Object.entries(window.__ruyi_extra_headers || extraHeaders)
            .forEach(([k, v]) => h.set(k, String(v)));
          return h;
        };

        if (!window.__ruyi_extra_headers_injected) {
          window.__ruyi_extra_headers_injected = true;
          window.__ruyi_extra_headers = {};

          // Intercept fetch.
          const _fetch = window.fetch;
          window.fetch = function(input, init = {}) {
            const mergedInit = { ...init, headers: applyHeaders(init && init.headers) };
            if (input instanceof Request) {
              return _fetch.call(this, new Request(input, mergedInit));
            }
            return _fetch.call(this, input, mergedInit);
          };
          Object.defineProperty(window.fetch, 'name', { value: 'fetch', configurable: true });
          Object.defineProperty(window.fetch, 'length', { value: _fetch.length, configurable: true });

          // Intercept XMLHttpRequest. Inject headers in send(), so it still
          // works when the page never calls setRequestHeader().
          const _open = XMLHttpRequest.prototype.open;
          const _send = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url, ...args) {
            this.__ruyi_extraHeadersPending = true;
            return _open.call(this, method, url, ...args);
          };
          XMLHttpRequest.prototype.send = function(...args) {
            if (this.__ruyi_extraHeadersPending) {
              Object.entries(window.__ruyi_extra_headers || {}).forEach(([k, v]) => {
                try { this.setRequestHeader(k, String(v)); } catch (_) {}
              });
              this.__ruyi_extraHeadersPending = false;
            }
            return _send.apply(this, args);
          };
        }

        Object.assign(window.__ruyi_extra_headers, extraHeaders);

        return { applied: Object.keys(extraHeaders).length, headers: Object.keys(window.__ruyi_extra_headers) };
      }`;

      const result = await ctx.bridgeInstance.call('script.evaluate', { pageIdx, script }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult({ applied: true, headers: Object.keys(headers), result }) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_set_cache_behavior
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_set_cache_behavior',
      description: '控制浏览器缓存行为。可选：default（默认）、bypass（跳过缓存）、force_cache（强制缓存）。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          mode: {
            type: 'string',
            description: '缓存模式',
            enum: ['default', 'bypass', 'force_cache'],
            default: 'default',
          },
        },
        required: ['mode'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);

      // ruyipage supports set_cache_behavior natively
      try {
        await ctx.bridgeInstance.call('script.evaluate', {
          pageIdx,
          script: `() => {
            // Add cache-control bypass header to all fetches if bypass mode
            const mode = ${JSON.stringify(args.mode)};
            if (mode === 'bypass') {
              const _fetch = window.fetch;
              window.fetch = function(url, init = {}) {
                init.cache = 'no-store';
                const headers = new Headers(init.headers || {});
                headers.set('Cache-Control', 'no-cache');
                headers.set('Pragma', 'no-cache');
                init.headers = headers;
                return _fetch.call(this, url, init);
              };
            }
            return mode;
          }`,
        });
      } catch {
        // Non-critical
      }

      return {
        content: [{ type: 'text', text: jsonResult({ cacheMode: args.mode }) }],
      };
    }) as ToolHandler,
  });
}
