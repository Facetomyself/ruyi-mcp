/**
 * Default MCP surface is automation. Reverse-era debug/source tools stay
 * registered only when RUYI_MCP_TOOLSET=all|expert|full.
 */

export type RuyiToolset = 'automation' | 'all';

export const EXPERT_ONLY_TOOLS = new Set<string>([
  'ruyi_break_on_xhr',
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
  if (value === 'all' || value === 'expert' || value === 'full') {
    return 'all';
  }
  return 'automation';
}
