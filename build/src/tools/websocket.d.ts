/**
 * WebSocket message capture tools.
 * Uses JS WebSocket Proxy injection to capture frames.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerWebSocketTools(register: ToolRegistrar, ctx: RuyiContext): void;
