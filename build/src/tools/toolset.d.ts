/**
 * Default MCP surface is automation. Reverse debugger/source tools stay
 * registered when RUYI_MCP_TOOLSET=debug|all|expert|full. The indexed
 * observe/act loop is a separate experimental agent surface.
 */
export type RuyiToolset = 'automation' | 'debug' | 'all' | 'agent' | 'compact';
export declare const COMPACT_TOOLS: Set<string>;
export declare const EXPERT_ONLY_TOOLS: Set<string>;
export declare const AGENT_LOOP_TOOLS: Set<string>;
export declare const AGENT_TOOLS: Set<string>;
export declare function resolveToolset(raw?: string | undefined): RuyiToolset;
export declare function debuggerEnabledByDefault(toolset?: RuyiToolset): boolean;
