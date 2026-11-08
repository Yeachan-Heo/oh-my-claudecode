/**
 * Trace Tools - MCP tools for viewing agent flow traces
 *
 * Provides trace_timeline and trace_summary tools for the /trace feature.
 * Reads session replay JSONL files and formats them for display.
 */
import { z } from 'zod';
import { ToolDefinition } from './types.js';
export declare const traceTimelineTool: ToolDefinition<{
    sessionId: z.ZodOptional<z.ZodString>;
    filter: z.ZodOptional<z.ZodEnum<['all', 'hooks', 'skills', 'agents', 'keywords', 'tools', 'modes']>>;
    last: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const traceSummaryTool: ToolDefinition<{
    sessionId: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
/**
 * All trace tools for registration
 */
export declare const traceTools: (ToolDefinition<{
    query: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    since: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    caseSensitive: z.ZodOptional<z.ZodBoolean>;
    contextChars: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    sessionId: z.ZodOptional<z.ZodString>;
    filter: z.ZodOptional<z.ZodEnum<["all", "hooks", "skills", "agents", "keywords", "tools", "modes"]>>;
    last: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    sessionId: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=trace-tools.d.ts.map