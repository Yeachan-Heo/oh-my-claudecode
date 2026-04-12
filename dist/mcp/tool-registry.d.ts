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
import { z } from 'zod';
/** Minimal tool definition shape shared across all tool families. */
export interface ToolDef {
    name: string;
    description: string;
    annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
    schema: z.ZodRawShape | z.ZodObject<z.ZodRawShape>;
    handler: (args: unknown) => Promise<{
        content: Array<{
            type: 'text';
            text: string;
        }>;
        isError?: boolean;
    }>;
}
/** All tools exposed by the standalone server, in registration order. */
export declare const allTools: ToolDef[];
export declare function zodToJsonSchema(schema: z.ZodRawShape | z.ZodObject<z.ZodRawShape>): {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
};
/** The exact payload returned by the ListTools MCP handler. */
export interface ListToolsEntry {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
    };
    annotations?: ToolDef['annotations'];
}
/**
 * Build the ListTools response payload exactly as standalone-server.ts sends it.
 * Tests call this directly to exercise the same code path as the live server.
 */
export declare function buildListToolsResponse(): {
    tools: ListToolsEntry[];
};
//# sourceMappingURL=tool-registry.d.ts.map