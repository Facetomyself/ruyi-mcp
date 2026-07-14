/**
 * Network forensics tools: list_network_requests, capture_start, capture_stop, capture_wait.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerNetworkTools(register: ToolRegistrar, ctx: RuyiContext): void;
