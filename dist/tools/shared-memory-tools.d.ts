/**
 * Shared Memory MCP Tools
 *
 * Provides tools for cross-session memory sync between agents
 * in /team and /pipeline workflows. Agents can write, read, list,
 * delete, and clean up shared key-value entries namespaced by
 * session group or pipeline run.
 *
 * Storage: .omc/state/shared-memory/{namespace}/{key}.json
 * Config gate: agents.sharedMemory.enabled in ~/.claude/.omc-config.json
 *
 * @see https://github.com/anthropics/oh-my-claudecode/issues/1119
 */
import { z } from 'zod';
import type { ToolDefinition } from './types.js';
export declare const sharedMemoryWriteTool: ToolDefinition<{
    key: z.ZodString;
    value: z.ZodUnknown;
    namespace: z.ZodString;
    ttl: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const sharedMemoryReadTool: ToolDefinition<{
    key: z.ZodString;
    namespace: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const sharedMemoryListTool: ToolDefinition<{
    namespace: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const sharedMemoryDeleteTool: ToolDefinition<{
    key: z.ZodString;
    namespace: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const sharedMemoryCleanupTool: ToolDefinition<{
    namespace: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>;
export declare const sharedMemoryTools: (ToolDefinition<{
    key: z.ZodString;
    value: z.ZodUnknown;
    namespace: z.ZodString;
    ttl: z.ZodOptional<z.ZodNumber>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    key: z.ZodString;
    namespace: z.ZodString;
    workingDirectory: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    namespace: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
}>)[];
//# sourceMappingURL=shared-memory-tools.d.ts.map