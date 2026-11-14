import type { ToolDef, ToolHandler } from './tools/types.js';
export interface RegisteredTool {
    tool: ToolDef;
    handler: ToolHandler;
}
export declare class ToolRegistry {
    readonly entries: Map<string, RegisteredTool>;
    private readonly validators;
    private readonly ajv;
    register: (entry: RegisteredTool) => void;
    execute(name: string, args: unknown): ReturnType<ToolHandler>;
    registerDiscovery(): void;
}
