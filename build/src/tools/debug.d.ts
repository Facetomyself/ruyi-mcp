/**
 * Native Firefox debugger tools via page.debugger (DevTools RDP).
 *
 * Breakpoints are planted by the debugger itself at source URL/line.
 * Preload `debugger;` injection is not used.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerDebugTools(register: ToolRegistrar, ctx: RuyiContext): void;
