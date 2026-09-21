/**
 * Indexed observe/act loop. Host LLM chooses op+index; Bridge executes
 * through human.* using the live snapshot, not caller CSS/XPath.
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerAgentTools(register, ctx) {
    register({
        tool: {
            name: 'ruyi_observe',
            description: '对当前页做一次 Gecko 可见节点编号快照。返回 role/name/ops 表与 snapshotId。' +
                '后续 ruyi_act 必须带同一 snapshotId 和下标；过期快照返回 miss，不盲着重试。' +
                '这是控制环观察，不是 RuyiTrace browser fact。',
            inputSchema: {
                type: 'object',
                properties: {
                    pageIdx: { type: 'number', default: 0 },
                    frameContextId: {
                        type: 'string',
                        description: '可选 frame browsing context ID；快照只扫该 frame。',
                    },
                    maxNodes: {
                        type: 'number',
                        description: '编号上限，默认 250',
                        default: 250,
                        minimum: 1,
                        maximum: 250,
                    },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('page.snapshot', {
                pageIdx,
                frameContextId: args.frameContextId,
                maxNodes: args.maxNodes ?? 250,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    register({
        tool: {
            name: 'ruyi_act',
            description: '对最近一次 ruyi_observe 的编号节点执行 CLICK / TYPE_TEXT / SELECT / SCROLL_* / WAIT。' +
                'CLICK 使用快照活引用的几何，不接受调用方 CSS/XPath。节点消失返回 miss。' +
                'P0 不含 Jev；宿主自己选 op 和 index。',
            inputSchema: {
                type: 'object',
                properties: {
                    op: {
                        type: 'string',
                        enum: [
                            'CLICK',
                            'TYPE_TEXT',
                            'SELECT',
                            'SCROLL_UP',
                            'SCROLL_DOWN',
                            'WAIT',
                            'DONE',
                            'BLOCKED',
                            'DRAG',
                        ],
                        description: '动作。P0 的 DRAG 返回 miss。',
                    },
                    snapshotId: {
                        type: 'string',
                        description: 'ruyi_observe 返回的 snapshotId；CLICK/TYPE_TEXT/SELECT 必填。',
                    },
                    index: {
                        type: 'number',
                        description: '编号表下标；CLICK/TYPE_TEXT/SELECT 必填。',
                        minimum: 0,
                    },
                    text: {
                        type: 'string',
                        description: 'TYPE_TEXT 要输入的文本，或 SELECT 的 option 文本/value。',
                    },
                    pageIdx: { type: 'number', default: 0 },
                    frameContextId: {
                        type: 'string',
                        description: '可选 frame browsing context ID，必须与 observe 同一 frame。',
                    },
                    waitMs: {
                        type: 'number',
                        description: 'WAIT 毫秒，默认 500',
                        default: 500,
                        minimum: 0,
                        maximum: 10000,
                    },
                },
                required: ['op'],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const result = await ctx.bridgeInstance.call('page.act', {
                pageIdx,
                frameContextId: args.frameContextId,
                op: args.op,
                snapshotId: args.snapshotId,
                index: args.index,
                text: args.text,
                waitMs: args.waitMs ?? 500,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
}
//# sourceMappingURL=agent.js.map