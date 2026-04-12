/**
 * Tool Registry for the Standalone MCP Server
 *
 * Single source of truth for the tool surface exposed by standalone-server.ts.
 * Extracted here so tests can import the same aggregation path without triggering
 * server-side effects (Server construction, transport startup, process.exit hooks).
 *
 * AST tools (ast_grep_search, ast_grep_replace) gracefully degrade at *runtime*
 * when @ast-grep/napi is unavailable — they are always present in the registry
 * but return a helpful error message instead of results.
 *
 * Team runtime tools (omc_run_team_start, omc_run_team_status) are intentionally
 * excluded: they live in the separate "team" MCP server (bridge/team-mcp.cjs).
 */
import { lspTools } from '../tools/lsp-tools.js';
import { astTools } from '../tools/ast-tools.js';
// IMPORTANT: Import from tool.js, NOT index.js!
// tool.js exports pythonReplTool with wrapped handler returning { content: [...] }
// index.js exports pythonReplTool with raw handler returning string
import { pythonReplTool } from '../tools/python-repl/tool.js';
import { stateTools } from '../tools/state-tools.js';
import { notepadTools } from '../tools/notepad-tools.js';
import { memoryTools } from '../tools/memory-tools.js';
import { traceTools } from '../tools/trace-tools.js';
import { z } from 'zod';
/** All tools exposed by the standalone server, in registration order. */
export const allTools = [
    ...lspTools,
    ...astTools,
    pythonReplTool,
    ...stateTools,
    ...notepadTools,
    ...memoryTools,
    ...traceTools,
];
// ---------------------------------------------------------------------------
// Zod → JSON Schema helpers (mirrors what the MCP server sends over the wire)
// ---------------------------------------------------------------------------
function zodTypeToJsonSchema(zodType) {
    const result = {};
    if (!zodType || !zodType._def) {
        return { type: 'string' };
    }
    if (zodType instanceof z.ZodOptional) {
        return zodTypeToJsonSchema(zodType._def.innerType);
    }
    if (zodType instanceof z.ZodDefault) {
        const inner = zodTypeToJsonSchema(zodType._def.innerType);
        inner.default = zodType._def.defaultValue();
        return inner;
    }
    const description = zodType._def?.description;
    if (description) {
        result.description = description;
    }
    if (zodType instanceof z.ZodString) {
        result.type = 'string';
    }
    else if (zodType instanceof z.ZodNumber) {
        result.type = zodType._def?.checks?.some((c) => c.kind === 'int')
            ? 'integer'
            : 'number';
    }
    else if (zodType instanceof z.ZodBoolean) {
        result.type = 'boolean';
    }
    else if (zodType instanceof z.ZodArray) {
        result.type = 'array';
        result.items = zodType._def?.type ? zodTypeToJsonSchema(zodType._def.type) : { type: 'string' };
    }
    else if (zodType instanceof z.ZodEnum) {
        result.type = 'string';
        result.enum = zodType._def?.values;
    }
    else if (zodType instanceof z.ZodObject) {
        return zodToJsonSchema(zodType.shape);
    }
    else if (zodType instanceof z.ZodRecord) {
        result.type = 'object';
        if (zodType._def?.valueType) {
            result.additionalProperties = zodTypeToJsonSchema(zodType._def.valueType);
        }
    }
    else {
        result.type = 'string';
    }
    return result;
}
export function zodToJsonSchema(schema) {
    const rawShape = schema instanceof z.ZodObject ? schema.shape : schema;
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(rawShape)) {
        const zodType = value;
        properties[key] = zodTypeToJsonSchema(zodType);
        const isOptional = zodType && typeof zodType.isOptional === 'function' && zodType.isOptional();
        if (!isOptional) {
            required.push(key);
        }
    }
    return { type: 'object', properties, required };
}
/**
 * Build the ListTools response payload exactly as standalone-server.ts sends it.
 * Tests call this directly to exercise the same code path as the live server.
 */
export function buildListToolsResponse() {
    return {
        tools: allTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: zodToJsonSchema(tool.schema),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
    };
}
//# sourceMappingURL=tool-registry.js.map