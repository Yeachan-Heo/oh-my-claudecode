import { z } from 'zod';
import { ToolDefinition } from './types.js';
export declare const sessionSearchTool: ToolDefinition<{
    query: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    since: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    caseSensitive: z.ZodOptional<z.ZodBoolean>;
    contextChars: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const sessionHistoryTools: ToolDefinition<{
    query: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    since: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    caseSensitive: z.ZodOptional<z.ZodBoolean>;
    contextChars: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>[];
//# sourceMappingURL=session-history-tools.d.ts.map