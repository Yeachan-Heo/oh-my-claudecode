/**
 * Tool Registry and MCP Server Creation
 *
 * This module exports all custom tools and provides helpers
 * for creating MCP servers with the Claude Agent SDK.
 */
import { z } from 'zod';
export { lspTools } from './lsp-tools.js';
export { astTools } from './ast-tools.js';
export { pythonReplTool } from './python-repl/index.js';
/**
 * Generic tool definition type
 */
export interface GenericToolDefinition {
    name: string;
    description: string;
    schema: z.ZodRawShape;
    handler: (args: unknown) => Promise<{
        content: Array<{
            type: 'text';
            text: string;
        }>;
    }>;
}
/**
 * All custom tools available in the system
 */
export declare const allCustomTools: GenericToolDefinition[];
/**
 * Get tools by category
 */
export declare function getToolsByCategory(category: 'lsp' | 'ast' | 'all'): GenericToolDefinition[];
/**
 * Create a Zod schema object from a tool's schema definition
 */
export declare function createZodSchema<T extends z.ZodRawShape>(schema: T): z.ZodObject<T>;
/**
 * Format for creating tools compatible with Claude Agent SDK
 */
export interface SdkToolFormat {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
    };
}
/**
 * Convert our tool definitions to SDK format
 */
export declare function toSdkToolFormat(tool: GenericToolDefinition): SdkToolFormat;
//# sourceMappingURL=index.d.ts.map