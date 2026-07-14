/**
 * BiDi trace tools: trace_start, trace_stop, trace_get_results.
 * These expose ruyipage's structured in-memory tracer, not kernel DOMTrace.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerTraceTools(register: ToolRegistrar, ctx: RuyiContext): void;
