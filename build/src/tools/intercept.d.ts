/**
 * Network intercept tools: intercept_requests, intercept_responses, intercept_wait, intercept_stop.
 * Wraps ruyipage's page.intercept API (BiDi network.addIntercept).
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerInterceptTools(register: ToolRegistrar, ctx: RuyiContext): void;
