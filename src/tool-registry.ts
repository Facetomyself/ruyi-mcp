import { Ajv, type ValidateFunction } from 'ajv';
import type { ToolDef, ToolHandler } from './tools/types.js';

export interface RegisteredTool {
  tool: ToolDef;
  handler: ToolHandler;
}

function strictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, strictSchema(item)]));
  if (source.type === 'object' && source.properties && source.additionalProperties === undefined) {
    result.additionalProperties = false;
  }
  return result;
}

export class ToolRegistry {
  readonly entries = new Map<string, RegisteredTool>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false });

  register = (entry: RegisteredTool): void => {
    if (this.entries.has(entry.tool.name)) throw new Error(`Duplicate tool registration: ${entry.tool.name}`);
    const schema = strictSchema(entry.tool.inputSchema) as ToolDef['inputSchema'];
    this.entries.set(entry.tool.name, { ...entry, tool: { ...entry.tool, inputSchema: schema } });
    this.validators.set(entry.tool.name, this.ajv.compile(schema));
  };

  async execute(name: string, args: unknown): ReturnType<ToolHandler> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    const validate = this.validators.get(name)!;
    if (!validate(args)) {
      const details = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
      throw new Error(`Invalid arguments for ${name}: ${details}`);
    }
    return entry.handler(args as Record<string, unknown>);
  }

  registerDiscovery(): void {
    this.register({
      tool: {
        name: 'ruyi_search_tools',
        description: '按名称或能力搜索完整工具目录，按需返回匹配工具的完整输入 schema。',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = String(args.query).trim().toLowerCase();
        if (!query) throw new Error('query must contain a search term');
        const terms = query.split(/\s+/);
        const scored = [...this.entries.values()].map(({ tool }) => ({
          tool,
          score: tool.name.toLowerCase() === query ? 1000 : terms.reduce((total, term) =>
            total + (tool.name.toLowerCase().includes(term) ? 10 : tool.description.toLowerCase().includes(term) ? 1 : 0), 0),
        })).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
        const offset = Number(args.offset ?? 0);
        const limit = Number(args.limit ?? 5);
        return { content: [{ type: 'text', text: JSON.stringify({
          tools: scored.slice(offset, offset + limit).map((item) => item.tool),
          total: scored.length,
          nextOffset: offset + limit < scored.length ? offset + limit : null,
        }) }] };
      },
    });
    this.register({
      tool: {
        name: 'ruyi_execute_tool',
        description: '执行搜索目录中的任一工具，严格校验目标工具 schema，复用原始会话和 handler。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            arguments: { type: 'object', additionalProperties: true },
          },
          required: ['name', 'arguments'],
        },
      },
      handler: async (args) => {
        const name = String(args.name);
        if (name === 'ruyi_execute_tool') throw new Error('Recursive tool execution is not supported');
        return this.execute(name, args.arguments);
      },
    });
  }
}
