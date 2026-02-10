/**
 * Tool Registry and MCP Server Creation
 *
 * This module exports all custom tools and provides helpers
 * for creating MCP servers with the Claude Agent SDK.
 */
import { z } from 'zod';
import { lspTools } from './lsp-tools.js';
import { astTools } from './ast-tools.js';
import { pythonReplTool } from './python-repl/index.js';
export { lspTools } from './lsp-tools.js';
export { astTools } from './ast-tools.js';
export { pythonReplTool } from './python-repl/index.js';
/**
 * All custom tools available in the system
 */
export const allCustomTools = [
    ...lspTools,
    ...astTools,
    pythonReplTool
];
/**
 * Get tools by category
 */
export function getToolsByCategory(category) {
    switch (category) {
        case 'lsp':
            return lspTools;
        case 'ast':
            return astTools;
        case 'all':
            return allCustomTools;
    }
}
/**
 * Create a Zod schema object from a tool's schema definition
 */
export function createZodSchema(schema) {
    return z.object(schema);
}
/**
 * Convert our tool definitions to SDK format
 */
export function toSdkToolFormat(tool) {
    const zodSchema = z.object(tool.schema);
    const jsonSchema = zodToJsonSchema(zodSchema);
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: jsonSchema
    };
}
/**
 * Simple Zod to JSON Schema converter for tool definitions
 */
function zodToJsonSchema(schema) {
    const shape = schema.shape;
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(shape)) {
        const zodType = value;
        properties[key] = zodTypeToJsonSchema(zodType);
        // Check if the field is required (not optional)
        if (!zodType.isOptional()) {
            required.push(key);
        }
    }
    return {
        type: 'object',
        properties,
        required
    };
}
/**
 * Convert individual Zod types to JSON Schema
 */
function zodTypeToJsonSchema(zodType) {
    const result = {};
    // Handle optional wrapper
    if (zodType instanceof z.ZodOptional) {
        return zodTypeToJsonSchema(zodType._def.innerType);
    }
    // Handle default wrapper
    if (zodType instanceof z.ZodDefault) {
        const inner = zodTypeToJsonSchema(zodType._def.innerType);
        inner.default = zodType._def.defaultValue();
        return inner;
    }
    // Get description if available
    const description = zodType._def.description;
    if (description) {
        result.description = description;
    }
    // Handle basic types
    if (zodType instanceof z.ZodString) {
        result.type = 'string';
    }
    else if (zodType instanceof z.ZodNumber) {
        result.type = zodType._def.checks?.some((c) => c.kind === 'int')
            ? 'integer'
            : 'number';
    }
    else if (zodType instanceof z.ZodBoolean) {
        result.type = 'boolean';
    }
    else if (zodType instanceof z.ZodArray) {
        result.type = 'array';
        result.items = zodTypeToJsonSchema(zodType._def.type);
    }
    else if (zodType instanceof z.ZodEnum) {
        result.type = 'string';
        result.enum = zodType._def.values;
    }
    else if (zodType instanceof z.ZodObject) {
        return zodToJsonSchema(zodType);
    }
    else {
        // Fallback for unknown types
        result.type = 'string';
    }
    return result;
}
//# sourceMappingURL=index.js.map