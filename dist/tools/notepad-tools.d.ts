/**
 * Notepad MCP Tools
 *
 * Provides tools for reading and writing notepad sections
 * (Priority Context, Working Memory, MANUAL).
 */
import { z } from 'zod';
import { ToolDefinition } from './types.js';
declare const SECTION_NAMES: [string, ...string[]];
export declare const notepadReadTool: ToolDefinition<{
    section: z.ZodOptional<z.ZodEnum<typeof SECTION_NAMES>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadWritePriorityTool: ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadWriteWorkingTool: ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadWriteManualTool: ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadPruneTool: ToolDefinition<{
    daysOld: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const notepadStatsTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
/**
 * All notepad tools for registration
 */
export declare const notepadTools: (ToolDefinition<{
    section: z.ZodOptional<z.ZodEnum<typeof SECTION_NAMES>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    daysOld: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
export {};
//# sourceMappingURL=notepad-tools.d.ts.map