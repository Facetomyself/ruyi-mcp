/**
 * Cookie management tools: get_cookies, set_cookies, delete_cookies.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerCookieTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_get_cookies
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_get_cookies',
      description: '获取当前页面的所有 cookies。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '标签页索引', default: 0 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('cookie.get', { pageIdx }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_set_cookies
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_set_cookies',
      description:
        '设置 cookies。传入 cookie 对象数组，每个对象需包含 name 和 value。' +
        '可选字段：domain, path, secure, httpOnly, sameSite, expiry。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '标签页索引', default: 0 },
          cookies: {
            type: 'array',
            description: 'Cookie 对象数组 [{name, value, domain?, path?, ...}]',
            items: { type: 'object' },
          },
        },
        required: ['cookies'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('cookie.set', {
        pageIdx,
        cookies: args.cookies,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_delete_cookies
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_delete_cookies',
      description: '删除 cookies。不传 name 则清除所有 cookies。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '标签页索引', default: 0 },
          name: { type: 'string', description: '要删除的 cookie 名称。不传则清除全部。' },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('cookie.delete', {
        pageIdx,
        name: args.name,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
