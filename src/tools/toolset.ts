/**
 * Default MCP surface is automation. Reverse debugger/source tools stay
 * registered when RUYI_MCP_TOOLSET=debug|all|expert|full. The indexed
 * observe/act loop is a separate experimental agent surface.
 */

export type RuyiToolset = 'automation' | 'debug' | 'all' | 'agent' | 'compact';

export const COMPACT_TOOLS = new Set<string>([
  'ruyi_browser_status',
  'ruyi_observe',
  'ruyi_act',
  'ruyi_search_tools',
  'ruyi_execute_tool',
]);

export const EXPERT_ONLY_TOOLS = new Set<string>([
  'ruyi_break_on_xhr',
  'ruyi_debug_disable',
  'ruyi_debug_enable',
  'ruyi_debug_expand_object',
  'ruyi_debug_get_frames',
  'ruyi_debug_get_paused_info',
  'ruyi_debug_get_scopes',
  'ruyi_debug_list_sources',
  'ruyi_debug_pause',
  'ruyi_debug_pause_on_exception',
  'ruyi_debug_resume',
  'ruyi_debug_set_breakpoint',
  'ruyi_debug_status',
  'ruyi_debug_step',
  'ruyi_debug_wait_paused',
  'ruyi_get_script_source',
  'ruyi_list_breakpoints',
  'ruyi_list_preload_scripts',
  'ruyi_list_scripts',
  'ruyi_remove_breakpoint',
  'ruyi_save_script_source',
  'ruyi_search_in_sources',
  'ruyi_set_breakpoint_on_text',
]);

export const AGENT_LOOP_TOOLS = new Set<string>([
  'ruyi_observe',
  'ruyi_act',
]);

export const AGENT_TOOLS = new Set<string>([
  'ruyi_new_page',
  'ruyi_attach_browser',
  'ruyi_navigate_page',
  'ruyi_observe',
  'ruyi_act',
  'ruyi_browser_quit',
  'ruyi_browser_status',
  'ruyi_export_session',
  'ruyi_handle_cloudflare',
]);

export function resolveToolset(raw = process.env.RUYI_MCP_TOOLSET): RuyiToolset {
  const value = String(raw || 'compact').trim().toLowerCase();
  if (value === 'compact') {
    return 'compact';
  }
  if (value === 'debug') {
    return 'debug';
  }
  if (value === 'all' || value === 'expert' || value === 'full') {
    return 'all';
  }
  if (value === 'agent') {
    return 'agent';
  }
  if (value === 'automation') {
    return 'automation';
  }
  throw new Error(`Unknown RUYI_MCP_TOOLSET: ${value}`);
}

export function debuggerEnabledByDefault(toolset = resolveToolset()): boolean {
  return true;
}
