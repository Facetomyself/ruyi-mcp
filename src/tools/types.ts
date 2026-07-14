/**
 * Shared type definitions for ruyi-mcp tools.
 */

export interface ToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
  properties?: Record<string, ToolProperty>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: string[];
  };
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}>;

export interface ToolRegistrar {
  (entry: { tool: ToolDef; handler: ToolHandler }): void;
}

export interface PageContext {
  getActivePageIdx(): number;
}

export function getPageIdx(args: Record<string, unknown>, ctx: PageContext): number {
  const raw = args.pageIdx;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return ctx.getActivePageIdx();
}
