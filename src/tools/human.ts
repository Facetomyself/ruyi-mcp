/**
 * Human behavior simulation tools: human_move, human_click, human_input.
 * ruyi unique — no equivalent in js-reverse-mcp.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerHumanTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_human_move
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_human_move',
      description:
        '模拟人类鼠标移动到目标元素。' +
        '支持 bezier 曲线和 windmouse 算法。' +
        '需要反检测场景下的鼠标操作，这是 js-reverse-mcp 不具备的能力。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标元素选择器' },
          pageIdx: { type: 'number', default: 0 },
          algorithm: {
            type: 'string',
            description: '移动算法',
            enum: ['bezier', 'windmouse'],
            default: 'bezier',
          },
          style: {
            type: 'string',
            description: '移动风格',
            enum: ['arc', 'linear'],
            default: 'arc',
          },
        },
        required: ['target'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('human.move', {
        pageIdx,
        target: args.target,
        algorithm: args.algorithm ?? 'bezier',
        style: args.style ?? 'arc',
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_human_click
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_human_click',
      description: '模拟人类鼠标点击。使用 windmouse/bezier 算法生成自然轨迹。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标元素选择器' },
          pageIdx: { type: 'number', default: 0 },
          algorithm: {
            type: 'string',
            enum: ['bezier', 'windmouse'],
            default: 'windmouse',
          },
        },
        required: ['target'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('human.click', {
        pageIdx,
        target: args.target,
        algorithm: args.algorithm ?? 'windmouse',
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_human_input
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_human_input',
      description: '模拟人类逐字输入文本（带延迟）。避免被检测为自动化输入。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标输入框选择器' },
          text: { type: 'string', description: '要输入的文本' },
          pageIdx: { type: 'number', default: 0 },
          delayMs: { type: 'number', description: '每个字符间延迟（毫秒），默认 50', default: 50 },
        },
        required: ['target', 'text'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('human.input', {
        pageIdx,
        target: args.target,
        text: args.text,
        delayMs: args.delayMs ?? 50,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
