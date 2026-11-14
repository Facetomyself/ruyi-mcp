/**
 * Shared type definitions for ruyi-mcp tools.
 */
export interface ToolProperty {
    type: string;
    additionalProperties?: boolean | ToolProperty;
    description?: string;
    enum?: string[];
    default?: unknown;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    items?: ToolProperty;
    properties?: Record<string, ToolProperty>;
    required?: string[];
}
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, ToolProperty>;
        required?: string[];
        oneOf?: Array<{
            required: string[];
        }>;
        additionalProperties?: boolean;
    };
}
export type ToolHandler = (args: Record<string, unknown>) => Promise<{
    content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
    }>;
    isError?: boolean;
}>;
export interface ToolRegistrar {
    (entry: {
        tool: ToolDef;
        handler: ToolHandler;
    }): void;
}
export interface PageContext {
    getActivePageIdx(): number;
}
export declare function getPageIdx(args: Record<string, unknown>, ctx: PageContext): number;
