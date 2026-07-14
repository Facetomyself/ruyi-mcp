/**
 * Script analysis tools: list_scripts, get_script_source, save_script_source, search_in_sources.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerScriptTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_list_scripts
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_list_scripts',
      description: '列出页面中加载的所有 JavaScript 脚本 URL。支持 URL 筛选。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', default: 0 },
          filter: { type: 'string', description: 'URL 筛选字符串（不区分大小写）' },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const filter = args.filter as string | undefined;

      let script = `() => {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        return scripts.map(s => ({
          src: s.src,
          type: s.type || 'text/javascript',
          async: s.async,
          defer: s.defer,
        }));
      }`;

      if (filter) {
        script = `() => {
          const filter = ${JSON.stringify(filter)}.toLowerCase();
          const scripts = Array.from(document.querySelectorAll('script[src]'));
          return scripts
            .filter(s => s.src.toLowerCase().includes(filter))
            .map(s => ({
              src: s.src,
              type: s.type || 'text/javascript',
              async: s.async,
              defer: s.defer,
            }));
        }`;
      }

      const result = await ctx.bridgeInstance.call('script.evaluate', { pageIdx, script }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_get_script_source
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_get_script_source',
      description: '获取指定 URL 脚本的源码片段。支持行号范围或字符偏移。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '脚本 URL（精确匹配优先，然后子串匹配）' },
          pageIdx: { type: 'number', default: 0 },
          startLine: { type: 'number', description: '起始行号（1-based）' },
          endLine: { type: 'number', description: '结束行号（1-based）' },
          offset: { type: 'number', description: '字符偏移（0-based，用于单行压缩文件）' },
          length: { type: 'number', description: '返回字符数（配合 offset 使用），默认 1000', default: 1000 },
        },
        required: ['url'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const url = args.url as string;

      const startLine = args.startLine as number | undefined;
      const endLine = args.endLine as number | undefined;
      const offset = args.offset as number | undefined;
      const length = (args.length as number | undefined) ?? 1000;

      const script = `async () => {
        const requested = ${JSON.stringify(url)};
        const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
        const resolved = scripts.find(s => s === requested)
          || scripts.find(s => s.includes(requested))
          || requested;

        const sliceSource = (text) => {
          const offset = ${offset === undefined ? 'null' : JSON.stringify(offset)};
          const length = ${JSON.stringify(length)};
          const startLine = ${startLine === undefined ? 'null' : JSON.stringify(startLine)};
          const endLine = ${endLine === undefined ? 'null' : JSON.stringify(endLine)};
          if (offset !== null) {
            return text.slice(offset, offset + length);
          }
          if (startLine !== null || endLine !== null) {
            const lines = text.split('\\n');
            const start = Math.max((startLine || 1) - 1, 0);
            const end = endLine ? Math.min(endLine, lines.length) : Math.min(start + 200, lines.length);
            return lines.slice(start, end).join('\\n');
          }
          return text.slice(0, 50000);
        };

        try {
          const resp = await fetch(resolved, { credentials: 'include', cache: 'force-cache' });
          if (!resp.ok) {
            return { ok: false, url: resolved, status: resp.status, error: 'HTTP ' + resp.status };
          }
          const text = await resp.text();
          return { ok: true, url: resolved, totalLength: text.length, source: sliceSource(text) };
        } catch (e) {
          return { ok: false, url: resolved, error: e && e.message ? e.message : String(e) };
        }
      }`;

      const result = await ctx.bridgeInstance.call('script.evaluate', {
        pageIdx,
        script,
        timeout: 15,
      }) as Record<string, unknown>;

      const payload = result.result as Record<string, unknown> | undefined;
      return {
        content: [{ type: 'text', text: jsonResult(result) }],
        isError: payload?.ok === false || undefined,
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_save_script_source
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_save_script_source',
      description: '保存脚本完整源码到本地文件。JSON 结果用 .json 扩展名，其他用 .js。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '脚本 URL' },
          filePath: { type: 'string', description: '本地保存路径（绝对路径）' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['url', 'filePath'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const url = args.url as string;
      const filePath = args.filePath as string;

      const script = `async () => {
        const requested = ${JSON.stringify(url)};
        const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
        const resolved = scripts.find(s => s === requested)
          || scripts.find(s => s.includes(requested))
          || requested;
        try {
          const resp = await fetch(resolved, { credentials: 'include', cache: 'force-cache' });
          if (!resp.ok) {
            return { ok: false, url: resolved, status: resp.status, error: 'HTTP ' + resp.status };
          }
          const text = await resp.text();
          return { ok: true, url: resolved, source: text, totalLength: text.length };
        } catch(e) {
          return { ok: false, url: resolved, error: e && e.message ? e.message : String(e) };
        }
      }`;

      const result = await ctx.bridgeInstance.call('script.evaluate', {
        pageIdx,
        script,
        timeout: 30,
      }) as Record<string, unknown>;

      const payload = result.result as Record<string, unknown> | undefined;
      if (payload?.ok === true && typeof payload.source === 'string') {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, payload.source, 'utf-8');
        return {
          content: [{
            type: 'text',
            text: jsonResult({ savedTo: filePath, url: payload.url, size: payload.source.length }),
          }],
        };
      }

      return {
        content: [{ type: 'text', text: jsonResult({ error: payload?.error || 'Failed to fetch script source', result }) }],
        isError: true,
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_search_in_sources
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_search_in_sources',
      description: '在页面已加载的 JS 源码中搜索字符串或正则表达式。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索字符串或正则表达式' },
          pageIdx: { type: 'number', default: 0 },
          caseSensitive: { type: 'boolean', default: false },
          isRegex: { type: 'boolean', default: false },
          urlFilter: { type: 'string', description: '仅搜索 URL 含此字符串的脚本' },
          maxResults: { type: 'number', description: '最大结果数，默认 30', default: 30 },
        },
        required: ['query'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const query = args.query as string;
      const isRegex = args.isRegex as boolean;
      const caseSensitive = args.caseSensitive as boolean;
      const urlFilter = args.urlFilter as string || '';
      const maxResults = (args.maxResults as number | undefined) ?? 30;

      // Search in all inline scripts and fetch-able external scripts
      const script = `async () => {
        const query = ${JSON.stringify(query)};
        const isRegex = ${isRegex};
        const caseSensitive = ${caseSensitive};
        const urlFilter = ${JSON.stringify(urlFilter)};
        const maxResults = ${maxResults};

        const results = [];
        const skipped = [];
        const pattern = isRegex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
        const seenExternal = new Set();

        const searchText = (src, text, kind) => {
          if (!text) return;
          if (text.length > 1000000) {
            skipped.push({ src, reason: 'too_large', size: text.length });
            return;
          }
          const lines = text.split('\\n');
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            const line = lines[i];
            const matched = pattern
              ? pattern.test(line)
              : (caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase()));
            if (matched) {
              results.push({
                src,
                kind,
                line: i + 1,
                preview: line.substring(0, 240).trim(),
              });
            }
          }
        };

        for (const el of document.querySelectorAll('script')) {
          const src = el.src || '(inline)';
          if (urlFilter && !src.toLowerCase().includes(urlFilter.toLowerCase())) continue;

          if (el.src) {
            if (seenExternal.has(el.src)) continue;
            seenExternal.add(el.src);
            try {
              const resp = await fetch(el.src, { credentials: 'include', cache: 'force-cache' });
              if (!resp.ok) {
                skipped.push({ src: el.src, reason: 'http_' + resp.status });
                continue;
              }
              searchText(el.src, await resp.text(), 'external');
            } catch (e) {
              skipped.push({ src: el.src, reason: e && e.message ? e.message : String(e) });
            }
          } else {
            searchText(src, el.textContent || '', 'inline');
          }
          if (results.length >= maxResults) break;
        }

        return { results, skipped, searchedExternal: seenExternal.size };
      }`;

      const result = await ctx.bridgeInstance.call('script.evaluate', {
        pageIdx,
        script,
        timeout: 15,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
