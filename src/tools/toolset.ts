/**
 * Default MCP surface is automation. Reverse debugger/source tools stay
 * registered when RUYI_MCP_TOOLSET=debug|all|expert|full.
 */

export type RuyiToolset = 'automation' | 'debug' | 'all';

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

export function resolveToolset(raw = process.env.RUYI_MCP_TOOLSET): RuyiToolset {
  const value = String(raw || 'automation').trim().toLowerCase();
  if (value === 'debug') {
    return 'debug';
  }
  if (value === 'all' || value === 'expert' || value === 'full') {
    return 'all';
  }
  return 'automation';
}

export function debuggerEnabledByDefault(toolset = resolveToolset()): boolean {
  return toolset !== 'automation';
}
