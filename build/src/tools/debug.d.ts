/**
 * Debug tools: set_breakpoint_on_text, break_on_xhr, list_breakpoints, remove_breakpoint.
 *
 * Note: Full CDP-style debugging (step, pause, get_paused_info) is not available
 * via WebDriver BiDi in the current Firefox. Instead we use soft breakpoints:
 * preload scripts that inject debugger; statements or Proxy wrappers around
 * XMLHttpRequest/Fetch.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerDebugTools(register: ToolRegistrar, ctx: RuyiContext): void;
