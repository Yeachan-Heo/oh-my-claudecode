/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */
import { z } from 'zod';
import { ToolDefinition } from './types.js';
declare const STATE_TOOL_MODES: [string, ...string[]];
export declare const stateReadTool: ToolDefinition<{
    mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>;
export declare const stateWriteTool: ToolDefinition<{
    mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
    active: z.ZodOptional<z.ZodBoolean>;
    iteration: z.ZodOptional<z.ZodNumber>;
    max_iterations: z.ZodOptional<z.ZodNumber>;
    current_phase: z.ZodOptional<z.ZodString>;
    task_description: z.ZodOptional<z.ZodString>;
    plan_path: z.ZodOptional<z.ZodString>;
    started_at: z.ZodOptional<z.ZodString>;
    completed_at: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>;
export declare const stateClearTool: ToolDefinition<{
    mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>;
export declare const stateListActiveTool: ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>;
export declare const stateGetStatusTool: ToolDefinition<{
    mode: z.ZodOptional<z.ZodEnum<typeof STATE_TOOL_MODES>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>;
/**
 * All state tools for registration
 */
export declare const stateTools: (ToolDefinition<{
    mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
    active: z.ZodOptional<z.ZodBoolean>;
    iteration: z.ZodOptional<z.ZodNumber>;
    max_iterations: z.ZodOptional<z.ZodNumber>;
    current_phase: z.ZodOptional<z.ZodString>;
    task_description: z.ZodOptional<z.ZodString>;
    plan_path: z.ZodOptional<z.ZodString>;
    started_at: z.ZodOptional<z.ZodString>;
    completed_at: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}> | ToolDefinition<{
    mode: z.ZodOptional<z.ZodEnum<typeof STATE_TOOL_MODES>>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    session_id: z.ZodOptional<z.ZodString>;
}>)[];
export {};
//# sourceMappingURL=state-tools.d.ts.map