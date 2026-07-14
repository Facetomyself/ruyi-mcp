/**
 * Anti-detection & fingerprint tools:
 *   set_fingerprint, emulate_geolocation, emulate_timezone,
 *   emulate_locale, emulate_useragent
 *
 * Note: proxy must be set at browser.launch time (ruyi_new_page params).
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerAntiDetectTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_set_fingerprint
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_set_fingerprint',
            description: '对当前页面应用指纹伪装。可设置地理位置、时区、语言、UserAgent、视口、CSP 绕过等。' +
                'ruyipage 支持 22 维硬件指纹随机化（需在 ruyi_new_page 时通过 fingerprint 参数配置）。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', description: '标签页索引', default: 0 },
                    geolocation: {
                        type: 'object',
                        description: '地理位置模拟',
                        properties: {
                            latitude: { type: 'number' },
                            longitude: { type: 'number' },
                            accuracy: { type: 'number', default: 100 },
                        },
                    },
                    timezone: { type: 'string', description: 'IANA 时区，如 "America/New_York"' },
                    locale: { type: 'string', description: '语言区域，如 "en-US"' },
                    userAgent: { type: 'string', description: '自定义 UserAgent 字符串' },
                    viewport: {
                        type: 'object',
                        description: '视口大小',
                        properties: {
                            width: { type: 'number', default: 1920 },
                            height: { type: 'number', default: 1080 },
                        },
                    },
                    screenOrientation: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['portrait-primary', 'landscape-primary'] },
                            angle: { type: 'number', default: 0 },
                        },
                    },
                    bypassCsp: { type: 'boolean', description: '绕过 CSP 限制' },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('fingerprint.set', {
                pageIdx,
                geolocation: args.geolocation,
                timezone: args.timezone,
                locale: args.locale,
                userAgent: args.userAgent,
                viewport: args.viewport,
                screenOrientation: args.screenOrientation,
                bypassCsp: args.bypassCsp,
            });
            ctx.state.fingerprintApplied = true;
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_emulate_geolocation
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_emulate_geolocation',
            description: '模拟浏览器地理位置（经纬度）。',
            inputSchema: {
                type: 'object',
                properties: {
                    latitude: { type: 'number', description: '纬度' },
                    longitude: { type: 'number', description: '经度' },
                    accuracy: { type: 'number', description: '精度（米），默认 100', default: 100 },
                    pageIdx: { type: 'number', default: 0 },
                },
                required: ['latitude', 'longitude'],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('emulation.geo', {
                pageIdx,
                latitude: args.latitude,
                longitude: args.longitude,
                accuracy: args.accuracy,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_emulate_timezone
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_emulate_timezone',
            description: '模拟浏览器时区。',
            inputSchema: {
                type: 'object',
                properties: {
                    timezoneId: { type: 'string', description: 'IANA 时区，如 "Asia/Tokyo"' },
                    pageIdx: { type: 'number', default: 0 },
                },
                required: ['timezoneId'],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('emulation.timezone', {
                pageIdx,
                timezoneId: args.timezoneId,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_emulate_locale
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_emulate_locale',
            description: '模拟浏览器语言/区域。',
            inputSchema: {
                type: 'object',
                properties: {
                    locale: { type: 'string', description: '语言区域代码，如 "en-US", "zh-CN"' },
                    pageIdx: { type: 'number', default: 0 },
                },
                required: ['locale'],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('emulation.locale', {
                pageIdx,
                locale: args.locale,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_handle_cloudflare
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_handle_cloudflare',
            description: '自动处理 Cloudflare Turnstile 验证（5s 盾）。' +
                '通过 BiDi 查找 CF iframe 并在内部触发点击，绕过 closed shadow root 限制。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    timeout: { type: 'number', description: '最大等待时间（秒），默认 30', default: 30 },
                    checkInterval: { type: 'number', description: '检测间隔（秒），默认 2', default: 2 },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('cf.handle', {
                pageIdx,
                timeout: args.timeout ?? 30,
                checkInterval: args.checkInterval ?? 2,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_emulate_useragent
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_emulate_useragent',
            description: '模拟浏览器 UserAgent 字符串。覆盖 navigator.userAgent。',
            inputSchema: {
                type: 'object',
                properties: {
                    userAgent: {
                        type: 'string',
                        description: '自定义 UserAgent 字符串',
                    },
                    pageIdx: { type: 'number', default: 0 },
                },
                required: ['userAgent'],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('emulation.useragent', {
                pageIdx,
                userAgent: args.userAgent,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_set_proxy
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_set_proxy',
            description: '⚠ 代理必须在 ruyi_new_page 时通过 proxy 参数设置。' +
                '浏览器启动后无法切换代理。此工具仅返回说明和当前代理状态。' +
                '如需切换代理，请先 ruyi_browser_quit，再用新代理调用 ruyi_new_page。',
            inputSchema: {
                type: 'object',
                properties: {
                    proxyUrl: { type: 'string', description: '代理 URL（仅供参考，不会实际切换）' },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            return {
                content: [{
                        type: 'text',
                        text: jsonResult({
                            warning: 'Proxy must be set at ruyi_new_page time via the proxy parameter.',
                            currentProxy: ctx.state.proxy || 'none',
                            guidance: 'To switch proxy: ruyi_browser_quit → ruyi_new_page with new proxy parameter',
                        }),
                    }],
            };
        }),
    });
}
//# sourceMappingURL=antidetect.js.map