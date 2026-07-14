/**
 * DOM interaction tools: dom_select, dom_get_info, dom_input, dom_click.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerDomTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_dom_select
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_dom_select',
      description:
        '在页面中定位 DOM 元素。支持 CSS 选择器、XPath、标签名、文本内容等多种定位方式。' +
        '格式: "#id" / "css:.class" / "xpath://div" / "tag:input" / "text:登录"',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '元素选择器。支持：#id, css:.class, xpath://div, tag:input, text:登录',
          },
          pageIdx: { type: 'number', default: 0 },
          timeout: { type: 'number', description: '等待超时（秒），默认 10', default: 10 },
        },
        required: ['selector'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('dom.select', {
        pageIdx,
        selector: args.selector,
        timeout: args.timeout ?? 10,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_dom_get_info
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_dom_get_info',
      description: '读取 DOM 元素的文本内容、HTML、表单值和指定属性。',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '元素选择器' },
          attribute: { type: 'string', description: '要读取的属性名（如 href, src, data-*）' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['selector'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('dom.info', {
        pageIdx,
        selector: args.selector,
        attribute: args.attribute,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_dom_input
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_dom_input',
      description:
        '向 DOM 元素输入文本或上传文件。' +
        '支持普通文本输入和文件路径上传。',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '目标元素选择器' },
          text: { type: 'string', description: '要输入的文本内容' },
          clear: { type: 'boolean', description: '输入前清空已有内容，默认 true', default: true },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['selector', 'text'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('dom.input', {
        pageIdx,
        selector: args.selector,
        text: args.text,
        clear: args.clear !== false,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_dom_click
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_dom_click',
      description: '点击 DOM 元素。',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '目标元素选择器' },
          pageIdx: { type: 'number', default: 0 },
        },
        required: ['selector'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('dom.click', {
        pageIdx,
        selector: args.selector,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
