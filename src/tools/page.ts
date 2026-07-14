/**
 * Page management tools: new_page, navigate_page, close_page, select_page, list_pages.
 */

import { RuyiContext } from '../ruyi-context.js';
import { ToolDef, ToolHandler, ToolRegistrar, getPageIdx } from './types.js';

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function registerPageTools(register: ToolRegistrar, ctx: RuyiContext): void {

  // -------------------------------------------------------------------------
  // ruyi_new_page
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_new_page',
      description:
        '在 ruyipage 指纹浏览器中打开新标签页并导航到目标 URL。' +
        '支持配置代理、指纹伪装、无头模式、隐私模式。' +
        '首次调用自动启动 Firefox 浏览器。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL（必填）' },
          timeout: { type: 'number', description: '导航超时（秒），默认 30', default: 30 },
          proxy: { type: 'string', description: '代理地址，如 http://127.0.0.1:7890 或 socks5://host:port' },
          headless: { type: 'boolean', description: '无头模式，默认 false', default: false },
          privateMode: { type: 'boolean', description: '隐私模式，默认 false', default: false },
          container: { type: 'boolean', description: '浏览器已启动时是否创建 container tab，默认 false', default: false },
          fingerprint: {
            type: 'object',
            description: '智能指纹配置（smart_fingerprint）',
            properties: {
              proxyHost: { type: 'string' },
              proxyPort: { type: 'number' },
              proxyUser: { type: 'string' },
              proxyPwd: { type: 'string' },
              requireCountry: { type: 'string', description: '要求代理出口国家，如 US' },
            },
          },
          traceEnabled: { type: 'boolean', description: '启用 BiDi trace 记录', default: false },
        },
        required: ['url'],
      },
    },
    handler: (async (args) => {
      const url = args.url as string;
      const timeout = args.timeout ?? 30;

      // The Python bridge can be restarted after a timeout/crash while the
      // TypeScript MCP context still has stale browserLaunched=true. Refresh
      // before navigating and force a relaunch when the bridge has no pages.
      if (ctx.state.browserLaunched) {
        const pages = await ctx.refreshPages();
        if (pages.length === 0) {
          ctx.reset();
        }
      }

      // First call launches the browser, then navigates the initial page.
      if (!ctx.state.browserLaunched) {
        await ctx.launch(args as Record<string, unknown>);
        const result = await ctx.bridgeInstance.call('page.navigate', {
          pageIdx: ctx.getActivePageIdx(),
          url,
          timeout,
        }) as Record<string, unknown>;

        await ctx.refreshPages();

        return {
          content: [{ type: 'text', text: jsonResult({ created: true, launched: true, ...result }) }],
        };
      }

      const launchOnlyArgs = ['proxy', 'headless', 'privateMode', 'fingerprint', 'traceEnabled'];
      const conflictingArgs = launchOnlyArgs.filter((key) => args[key] !== undefined);
      if (conflictingArgs.length > 0) {
        throw new Error(
          `Browser is already launched; ${conflictingArgs.join(', ')} only apply at launch time. ` +
            'Call ruyi_browser_quit first, then ruyi_new_page with the new launch parameters.'
        );
      }

      // Browser already exists: ruyi_new_page must create a new tab, not
      // silently navigate the current active page.
      const result = await ctx.bridgeInstance.call('page.new', {
        url,
        container: args.container ?? false,
      }) as Record<string, unknown>;

      const newPageIdx = result.pageIdx as number;
      ctx.setActivePageIdx(newPageIdx);
      await ctx.refreshPages();

      return {
        content: [{ type: 'text', text: jsonResult({ created: true, launched: false, ...result }) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_navigate_page
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_navigate_page',
      description: '导航已有标签页到新 URL，或执行刷新/前进/后退。',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: '导航类型',
            enum: ['url', 'back', 'forward', 'reload'],
            default: 'url',
          },
          url: { type: 'string', description: '目标 URL（type=url 时必填）' },
          pageIdx: { type: 'number', description: '标签页索引，默认当前活跃页', default: 0 },
          timeout: { type: 'number', description: '超时（秒），默认 30', default: 30 },
        },
        required: [],
      },
    },
    handler: (async (args) => {
      const navType = (args.type as string) || 'url';
      const pageIdx = getPageIdx(args, ctx);

      let result: Record<string, unknown>;

      if (navType === 'reload') {
        result = await ctx.bridgeInstance.call('page.reload', { pageIdx }) as Record<string, unknown>;
      } else if (navType === 'back' || navType === 'forward') {
        // ruyipage doesn't have direct back/forward, use JS
        result = await ctx.bridgeInstance.call('script.evaluate', {
          pageIdx,
          script: navType === 'back'
            ? '() => { window.history.back(); return location.href; }'
            : '() => { window.history.forward(); return location.href; }',
        }) as Record<string, unknown>;
      } else {
        const url = args.url as string;
        if (!url) throw new Error('url is required when type=url');
        result = await ctx.bridgeInstance.call('page.navigate', {
          pageIdx,
          url,
          timeout: args.timeout ?? 30,
        }) as Record<string, unknown>;
      }

      await ctx.refreshPages();

      return {
        content: [{ type: 'text', text: jsonResult({ navigated: true, ...result }) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_close_page
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_close_page',
      description: '关闭指定标签页。不能关闭主标签页（pageIdx=0）。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '要关闭的标签页索引', default: 1 },
        },
        required: ['pageIdx'],
      },
    },
    handler: (async (args) => {
      const pageIdx = args.pageIdx as number;
      const result = await ctx.bridgeInstance.call('page.close', { pageIdx }) as Record<string, unknown>;

      await ctx.refreshPages();

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_select_page
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_select_page',
      description: '切换活跃标签页。',
      inputSchema: {
        type: 'object',
        properties: {
          pageIdx: { type: 'number', description: '标签页索引' },
        },
        required: ['pageIdx'],
      },
    },
    handler: (async (args) => {
      const pageIdx = args.pageIdx as number;
      await ctx.bridgeInstance.call('page.select', { pageIdx });
      ctx.setActivePageIdx(pageIdx);

      return {
        content: [{ type: 'text', text: jsonResult({ selectedPageIdx: pageIdx }) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_list_pages
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_list_pages',
      description: '列出所有打开的标签页。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: (async () => {
      const result = await ctx.bridgeInstance.call('page.list') as Record<string, unknown>;
      await ctx.refreshPages();

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_list_frames
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_list_frames',
      description:
        '列出当前页面中的所有 iframe/frame（包括嵌套子 frame）。' +
        '返回每个 frame 的 contextId、url、isCrossOrigin 信息。',
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
      const result = await ctx.bridgeInstance.call('frame.list', { pageIdx }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });

  // -------------------------------------------------------------------------
  // ruyi_select_frame
  // -------------------------------------------------------------------------
  register({
    tool: {
      name: 'ruyi_select_frame',
      description:
        '选择指定的 iframe/frame。传入 contextId（从 ruyi_list_frames 获取）。' +
        '选择后的 frame 可在后续 evaluate_script 中通过 frameContextId 参数操作。',
      inputSchema: {
        type: 'object',
        properties: {
          contextId: { type: 'string', description: 'frame 的 browsing context ID' },
          pageIdx: { type: 'number', description: '标签页索引', default: 0 },
        },
        required: ['contextId'],
      },
    },
    handler: (async (args) => {
      const pageIdx = getPageIdx(args, ctx);
      const result = await ctx.bridgeInstance.call('frame.select', {
        pageIdx,
        contextId: args.contextId,
      }) as Record<string, unknown>;

      return {
        content: [{ type: 'text', text: jsonResult(result) }],
      };
    }) as ToolHandler,
  });
}
