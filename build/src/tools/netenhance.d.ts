/**
 * Network enhancement tools: set_extra_headers, set_cache_behavior.
 * ruyi unique — request/response interception and modification.
 *
 * Note: Full intercept_requests/intercept_responses require BiDi network
 * interception which ruyipage supports. These are available via page.intercept.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerNetEnhanceTools(register: ToolRegistrar, ctx: RuyiContext): void;
