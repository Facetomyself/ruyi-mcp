/**
 * Indexed observe/act loop. Host LLM chooses op+index; Bridge executes
 * through human.* using the live snapshot, not caller CSS/XPath.
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerAgentTools(register: ToolRegistrar, ctx: RuyiContext): void;
