export function registerBorrowedSessionTools(register, ctx) {
    register({
        tool: {
            name: 'ruyi_attach_trace_session',
            description: '借用活动 RuyiTrace 会话的控制租约，读取本地 restricted descriptor；不创建第二条 BiDi session，不接管浏览器生命周期。',
            inputSchema: { type: 'object', properties: { sessionPath: { type: 'string' } }, required: ['sessionPath'] },
        },
        handler: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await ctx.attachBorrowedSession(String(args.sessionPath))) }] }),
    });
    register({
        tool: {
            name: 'ruyi_trace_control',
            description: '经 RuyiTrace owner 的现有 BiDi session 执行有界页面操作，保留 trace ownership。',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['navigate', 'query', 'click', 'fill', 'press', 'scroll', 'wait', 'screenshot'] },
                    url: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' },
                    deltaX: { type: 'number' }, deltaY: { type: 'number' }, maxElements: { type: 'integer', minimum: 1, maximum: 250 },
                    state: { type: 'string', enum: ['present', 'visible', 'hidden'] }, milliseconds: { type: 'integer', minimum: 0, maximum: 10000 },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 },
                },
                required: ['action'],
            },
        },
        handler: async (args) => {
            if (!ctx.borrowedSession)
                throw new Error('Attach a RuyiTrace session first');
            const { action, timeoutMs, ...operationArgs } = args;
            return { content: [{ type: 'text', text: JSON.stringify(await ctx.borrowedSession.command(String(action), operationArgs, Number(timeoutMs ?? 10000))) }] };
        },
    });
}
//# sourceMappingURL=borrowed-session.js.map