/**
 * Default MCP surface is automation. Reverse debugger/source tools stay
 * registered when RUYI_MCP_TOOLSET=debug|all|expert|full.
 */
export type RuyiToolset = 'automation' | 'debug' | 'all';
export declare const EXPERT_ONLY_TOOLS: Set<string>;
export declare function resolveToolset(raw?: string | undefined): RuyiToolset;
export declare function debuggerEnabledByDefault(toolset?: RuyiToolset): boolean;
