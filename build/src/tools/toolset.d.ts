/**
 * Default MCP surface is automation. Reverse-era debug/source tools stay
 * registered only when RUYI_MCP_TOOLSET=all|expert|full.
 */
export type RuyiToolset = 'automation' | 'all';
export declare const EXPERT_ONLY_TOOLS: Set<string>;
export declare function resolveToolset(raw?: string | undefined): RuyiToolset;
