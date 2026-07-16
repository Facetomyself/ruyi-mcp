/**
 * Human behavior simulation tools: human_move, human_click, human_drag, human_input.
 * ruyi unique — no equivalent in js-reverse-mcp.
 */
import { getPageIdx } from './types.js';
function jsonResult(data) {
    return JSON.stringify(data, null, 2);
}
export function registerHumanTools(register, ctx) {
    // -------------------------------------------------------------------------
    // ruyi_human_move
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_human_move',
            description: '模拟人类鼠标移动到目标元素。' +
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
                        enum: ['arc', 'line', 'line_then_arc', 'line_overshoot_arc_back', 'linear'],
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
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
    // -------------------------------------------------------------------------
    // ruyi_human_drag
    // -------------------------------------------------------------------------
    register({
        tool: {
            name: 'ruyi_human_drag',
            description: '执行原子的拟人鼠标拖拽：move → hold → wait → human_move → wait → release。' +
                'ruyiPage 1.2.50 会把按下到释放合并为单次 BiDi input.performActions，' +
                '适合滑块、排序和 drag-and-drop 场景。source/target 可用选择器或 viewport 坐标。',
            inputSchema: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: '起点元素选择器；与 sourcePoint 二选一' },
                    sourcePoint: {
                        type: 'object',
                        description: '起点 viewport 坐标；与 source 二选一',
                        properties: {
                            x: { type: 'number' },
                            y: { type: 'number' },
                        },
                        required: ['x', 'y'],
                    },
                    target: { type: 'string', description: '终点元素选择器；与 targetPoint 二选一' },
                    targetPoint: {
                        type: 'object',
                        description: '终点 viewport 坐标；与 target 二选一',
                        properties: {
                            x: { type: 'number' },
                            y: { type: 'number' },
                        },
                        required: ['x', 'y'],
                    },
                    pageIdx: { type: 'number', default: 0 },
                    algorithm: {
                        type: 'string',
                        enum: ['bezier', 'windmouse'],
                        default: 'bezier',
                    },
                    style: {
                        type: 'string',
                        enum: ['arc', 'line', 'line_then_arc', 'line_overshoot_arc_back', 'linear'],
                        default: 'arc',
                    },
                    holdMs: {
                        type: 'number',
                        description: '按下后等待毫秒数，默认 120',
                        default: 120,
                        minimum: 0,
                        maximum: 10000,
                    },
                    releaseMs: {
                        type: 'number',
                        description: '到达目标后、释放前等待毫秒数，默认 80',
                        default: 80,
                        minimum: 0,
                        maximum: 10000,
                    },
                    button: {
                        type: 'number',
                        description: '鼠标按钮：0 左键、1 中键、2 右键',
                        default: 0,
                        minimum: 0,
                        maximum: 2,
                    },
                },
                required: [],
            },
        },
        handler: (async (args) => {
            const pageIdx = getPageIdx(args, ctx);
            const source = args.sourcePoint ?? args.source;
            const target = args.targetPoint ?? args.target;
            if (source === undefined) {
                throw new Error('source or sourcePoint is required');
            }
            if (target === undefined) {
                throw new Error('target or targetPoint is required');
            }
            if (args.source !== undefined && args.sourcePoint !== undefined) {
                throw new Error('source and sourcePoint are mutually exclusive');
            }
            if (args.target !== undefined && args.targetPoint !== undefined) {
                throw new Error('target and targetPoint are mutually exclusive');
            }
            const result = await ctx.bridgeInstance.call('human.drag', {
                pageIdx,
                source,
                target,
                algorithm: args.algorithm ?? 'bezier',
                style: args.style ?? 'arc',
                holdMs: args.holdMs ?? 120,
                releaseMs: args.releaseMs ?? 80,
                button: args.button ?? 0,
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
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
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
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
            });
            return {
                content: [{ type: 'text', text: jsonResult(result) }],
            };
        }),
    });
}
//# sourceMappingURL=human.js.map