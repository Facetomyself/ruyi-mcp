/**
 * Fingerprint trace tools: trace_start, trace_stop, trace_get_results.
 * ruyi unique — ruyitrace DOM API tracing integration.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerTraceTools(register: ToolRegistrar, ctx: RuyiContext): void;
