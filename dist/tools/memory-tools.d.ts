/**
 * Project Memory MCP Tools
 *
 * Provides tools for reading and writing project memory.
 */
import { z } from 'zod';
import { ToolDefinition } from './types.js';
export declare const projectMemoryReadTool: ToolDefinition<{
    section: z.ZodOptional<z.ZodEnum<['all', 'techStack', 'build', 'conventions', 'structure', 'notes', 'directives']>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const projectMemoryWriteTool: ToolDefinition<{
    memory: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    merge: z.ZodOptional<z.ZodBoolean>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const projectMemoryAddNoteTool: ToolDefinition<{
    category: z.ZodString;
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const projectMemoryAddDirectiveTool: ToolDefinition<{
    directive: z.ZodString;
    context: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodEnum<['high', 'normal']>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
/**
 * All memory tools for registration
 */
export declare const memoryTools: (ToolDefinition<{
    section: z.ZodOptional<z.ZodEnum<["all", "techStack", "build", "conventions", "structure", "notes", "directives"]>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    memory: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    merge: z.ZodOptional<z.ZodBoolean>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    category: z.ZodString;
    content: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    directive: z.ZodString;
    context: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodEnum<["high", "normal"]>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=memory-tools.d.ts.map