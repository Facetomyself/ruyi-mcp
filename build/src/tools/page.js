/**
 * Page management tools: new_page, navigate_page, close_page, select_page, list_pages.
 */
import { debuggerEnabledByDefault } from './toolset.js';
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerPageTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_attach_browser
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_attach_browser',
            description: '通过 Firefox WebDriver BiDi 端口接管已启动的浏览器，不新建进程、不导航页面，' +
                'MCP 退出或 bridge 超时时保留外部浏览器。',
            inputSchema: {
                type: 'object',
                properties: {
                    address: { type: 'string', description: '监听地址，默认 127.0.0.1', default: '127.0.0.1' },
                    port: { type: 'number', description: 'Firefox --remote-debugging-port', minimum: 1, maximum: 65535 },
                    profilePath: { type: 'string', description: '现有 Firefox profile 绝对路径（可选；外部数据，Bridge 不会创建或删除）' },
                },
                required: ['port'],
            },
        },
        handler: (async (args) => {
            if (ctx.state.browserLaunched) {
                const pages = await ctx.refreshPages();
                if (pages.length > 0) {
                    throw new Error('A browser session is already active; detach or restart the MCP bridge before attaching another one.');
                }
                ctx.reset();
            }
            const result = await ctx.launch({
                existingOnly: true,
                address: args.address ?? '127.0.0.1',
                port: args.port,
                profilePath: args.profilePath,
                closeOnExit: false,
            });
            return {
                content: [{ type: 'text', text: jsonResult({ attached: true, ...result }) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_new_page
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_new_page',
            description: '在 ruyipage 指纹浏览器中打开新标签页并导航到目标 URL。' +
                '支持配置代理、指纹伪装、无头模式、隐私模式。' +
                '国内机器使用 Cliproxy 时，浏览器代理只能指向已验证的本机 Cliproxy chained sidecar listener，不能直连 provider endpoint。' +
                '首次调用自动启动 Firefox 浏览器。',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: '目标 URL（必填）' },
                    timeout: { type: 'number', description: '导航超时（秒），默认 30', default: 30 },
                    proxy: {
                        type: 'string',
                        description: '浏览器第一跳代理。Cliproxy 场景仅填写已验证的本机 chained sidecar loopback listener，例如 http://127.0.0.1:<sidecar-port>；主 Clash http://127.0.0.1:7897 不会自动转到 Cliproxy。不得填写 *.cliproxy.io:3010 或 provider 账密 URL。',
                    },
                    headless: { type: 'boolean', description: '无头模式，默认 false', default: false },
                    privateMode: { type: 'boolean', description: '隐私模式，默认 false', default: false },
                    profilePath: {
                        type: 'string',
                        description: '外部持久 Firefox profile 的绝对路径（可选）；默认在 RUYI_MCP_PROFILE_ROOT 创建并在正常退出时回收受控临时 profile',
                    },
                    container: { type: 'boolean', description: '浏览器已启动时是否创建 container tab，默认 false', default: false },
                    enableDebugger: {
                        type: 'boolean',
                        description: '启动 Firefox DevTools RDP（--start-debugger-server）供 page.debugger 下断点。' +
                            '必须在 launch 时打开，启动后无法补开。debug/all toolset 默认 true，automation 默认 false。',
                    },
                    debuggerPort: {
                        type: 'number',
                        description: 'RDP 端口。新启动默认随机本机端口；attach 且 enableDebugger 时必填。',
                    },
                    fingerprint: {
                        type: 'object',
                        description: '智能指纹配置（smart_fingerprint）。UA 跟随真实 Firefox 主版本；Canvas/Audio seed 由内核生成。',
                        properties: {
                            proxyHost: { type: 'string', description: '浏览器第一跳 host；Cliproxy 场景填已验证的本机 chained sidecar host，不填 provider host。' },
                            proxyPort: { type: 'number', description: '浏览器第一跳端口；Cliproxy 场景填 sidecar listener port，主 Clash 7897 不等于 Cliproxy relay。' },
                            proxyUser: { type: 'string', description: '第一跳认证；不得填入 Cliproxy provider 账号。' },
                            proxyPwd: { type: 'string', description: '第一跳认证；不得填入 Cliproxy provider 密码。' },
                            requireCountry: { type: 'string', description: '要求代理出口国家，如 US' },
                            firefoxVersion: { type: 'number', description: '生成 UA 用的 Firefox 主版本；省略则读取 RUYI_FIREFOX_PATH 可执行文件版本' },
                            geolocationEnabled: { type: 'boolean', description: '是否写入 fpfile/BiDi 地理位置，默认 true' },
                            geolocationLatitude: { type: 'number', description: '覆盖探测到的纬度' },
                            geolocationLongitude: { type: 'number', description: '覆盖探测到的经度' },
                            geolocationAccuracy: { type: 'number', description: '定位精度（米），默认 15000' },
                            geolocationAltitude: { type: 'number', description: '可选海拔' },
                            geolocationHeading: { type: 'number', description: '可选朝向 0-360' },
                            geolocationSpeed: { type: 'number', description: '可选速度' },
                            geolocationPermission: { type: 'string', description: 'prompt / granted / denied，默认 granted' },
                            webrtcLocalIpv4: { type: 'string', description: '可选 WebRTC 本地 IPv4' },
                            webrtcPublicIpv4: { type: 'string', description: '可选 WebRTC 公网 IPv4' },
                            manualGeo: { type: 'object', description: '在线 Geo 全部失败时的显式回退（ip/country_code/timezone/latitude/longitude）' },
                        },
                    },
                },
                required: ['url'],
            },
        },
        handler: (async (args) => {
            const url = args.url;
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
                const enableDebugger = args.enableDebugger === undefined
                    ? debuggerEnabledByDefault()
                    : Boolean(args.enableDebugger);
                await ctx.launch({
                    ...args,
                    enableDebugger,
                });
                const result = await ctx.bridgeInstance.call('page.navigate', {
                    pageIdx: ctx.getActivePageIdx(),
                    url,
                    timeout,
                });
                await ctx.refreshPages();
                return {
                    content: [{ type: 'text', text: jsonResult({ created: true, launched: true, ...result }) }],
                };
            }
            const launchOnlyArgs = ['proxy', 'headless', 'privateMode', 'profilePath', 'fingerprint', 'enableDebugger', 'debuggerPort'];
            const conflictingArgs = launchOnlyArgs.filter((key) => args[key] !== undefined);
            if (conflictingArgs.length > 0) {
                throw new Error(`Browser is already launched; ${conflictingArgs.join(', ')} only apply at launch time. ` +
                    'Call ruyi_browser_quit first, then ruyi_new_page with the new launch parameters.');
            }
            // Browser already exists: ruyi_new_page must create a new tab, not
            // silently navigate the current active page.
            const result = await ctx.bridgeInstance.call('page.new', {
                url,
                timeout,
                container: args.container ?? false,
            });
            const newPageIdx = result.pageIdx;
            ctx.setActivePageIdx(newPageIdx);
            await ctx.refreshPages();
            return {
                content: [{ type: 'text', text: jsonResult({ created: true, launched: false, ...result }) }],
            };
        }),
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
            const navType = args.type || 'url';
            const pageIdx = getPageIdx(args, ctx);
            let result;
            if (navType === 'reload') {
                result = await ctx.bridgeInstance.call('page.reload', { pageIdx });
            }
            else if (navType === 'back' || navType === 'forward') {
                // ruyipage doesn't have direct back/forward, use JS
                result = await ctx.bridgeInstance.call('script.evaluate', {
                    pageIdx,
                    script: navType === 'back'
                        ? '() => { window.history.back(); return location.href; }'
                        : '() => { window.history.forward(); return location.href; }',
                });
            }
            else {
                const url = args.url;
                if (!url)
                    throw new Error('url is required when type=url');
                result = await ctx.bridgeInstance.call('page.navigate', {
                    pageIdx,
                    url,
                    timeout: args.timeout ?? 30,
                });
            }
            await ctx.refreshPages();
            return {
                content: [{ type: 'text', text: jsonResult({ navigated: true, ...result }) }],
            };
        }),
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
            const pageIdx = args.pageIdx;
            const result = await ctx.bridgeInstance.call('page.close', { pageIdx });
            await ctx.refreshPages();
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
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
            const pageIdx = args.pageIdx;
            await ctx.bridgeInstance.call('page.select', { pageIdx });
            ctx.setActivePageIdx(pageIdx);
            return {
                content: [{ type: 'text', text: jsonResult({ selectedPageIdx: pageIdx }) }],
            };
        }),
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
            const result = await ctx.bridgeInstance.call('page.list');
            await ctx.refreshPages();
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_list_frames
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_list_frames',
            description: '列出当前页面中的所有 iframe/frame（包括嵌套子 frame）。' +
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
            const result = await ctx.bridgeInstance.call('frame.list', { pageIdx });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_select_frame
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_select_frame',
            description: '选择指定的 iframe/frame。contextId（从 ruyi_list_frames 获取）最稳定；' +
                '也可传 selector，由 ruyiPage 通过 iframe.contentWindow 精确映射 srcdoc 或同 URL frame。' +
                '返回的 contextId 不是隐式全局状态；后续 evaluate、DOM 与 human 工具必须显式传入 frameContextId。',
            inputSchema: {
                type: 'object',
                properties: {
                    contextId: { type: 'string', description: 'frame 的 browsing context ID' },
                    selector: { type: 'string', description: 'iframe/frame 元素选择器；与 contextId 二选一' },
                    pageIdx: { type: 'number', description: '标签页索引', default: 0 },
                },
                required: [],
                oneOf: [
                    { required: ['contextId'] },
                    { required: ['selector'] },
                ],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const contextId = typeof args.contextId === 'string' && args.contextId.trim()
                ? args.contextId.trim()
                : undefined;
            const selector = typeof args.selector === 'string' && args.selector.trim()
                ? args.selector.trim()
                : undefined;
            if ((contextId ? 1 : 0) + (selector ? 1 : 0) !== 1) {
                throw new Error('Exactly one of contextId or selector is required');
            }
            const result = await ctx.bridgeInstance.call('frame.select', {
                pageIdx,
                contextId,
                selector,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
}
//# sourceMappingURL=page.js.map