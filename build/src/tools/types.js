/**
 * Shared type definitions for ruyi-mcp tools.
 */
export function getPageIdx(args, ctx) {
    const raw = args.pageIdx;
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return ctx.getActivePageIdx();
}
//# sourceMappingURL=types.js.map