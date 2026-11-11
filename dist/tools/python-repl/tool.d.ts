/**
 * Python REPL Tool - Main handler implementation
 *
 * Provides a persistent Python REPL environment for code execution.
 * JSON-RPC 2.0 over Unix socket with session locking and timeout escalation.
 *
 * Actions:
 * - execute: Run Python code in the persistent environment
 * - interrupt: Send interrupt to running code with signal escalation
 * - reset: Clear the execution namespace
 * - get_state: Get memory usage and variable list
 *
 * @module python-repl/tool
 */
import { z } from 'zod';
import type { PythonReplInput } from './types.js';
/**
 * Input schema for the Python REPL tool.
 * Validates and types all input parameters.
 */
export declare const pythonReplSchema: z.ZodObject<{
    action: z.ZodEnum<["execute", "interrupt", "reset", "get_state"]>;
    researchSessionID: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
    executionLabel: z.ZodOptional<z.ZodString>;
    executionTimeout: z.ZodDefault<z.ZodNumber>;
    queueTimeout: z.ZodDefault<z.ZodNumber>;
    projectDir: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    action: "execute" | "interrupt" | "reset" | "get_state";
    researchSessionID: string;
    executionTimeout: number;
    queueTimeout: number;
    code?: string | undefined;
    executionLabel?: string | undefined;
    projectDir?: string | undefined;
}, {
    action: "execute" | "interrupt" | "reset" | "get_state";
    researchSessionID: string;
    code?: string | undefined;
    executionLabel?: string | undefined;
    executionTimeout?: number | undefined;
    queueTimeout?: number | undefined;
    projectDir?: string | undefined;
}>;
export type PythonReplSchemaInput = z.infer<typeof pythonReplSchema>;
/**
 * Get and increment the execution counter for a session.
 * Used for tracking execution order in a session.
 */
declare function getNextExecutionCount(sessionId: string): number;
/**
 * Main handler for the Python REPL tool.
 *
 * @param input - Validated input from the tool call
 * @returns Formatted string output for Claude
 *
 * @example
 * ```typescript
 * const output = await pythonReplHandler({
 *   action: 'execute',
 *   researchSessionID: 'my-session',
 *   code: 'print("Hello, World!")',
 * });
 * ```
 */
export declare function pythonReplHandler(input: PythonReplInput): Promise<string>;
/**
 * Tool definition for registration with the tool registry.
 */
export declare const pythonReplTool: {
    name: string;
    description: string;
    schema: {
        action: z.ZodEnum<["execute", "interrupt", "reset", "get_state"]>;
        researchSessionID: z.ZodString;
        code: z.ZodOptional<z.ZodString>;
        executionLabel: z.ZodOptional<z.ZodString>;
        executionTimeout: z.ZodDefault<z.ZodNumber>;
        queueTimeout: z.ZodDefault<z.ZodNumber>;
        projectDir: z.ZodOptional<z.ZodString>;
    };
    handler: (args: unknown) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
export { getNextExecutionCount };
/**
 * Reset the execution counter for a session.
 * Useful for testing or when manually resetting state.
 */
export declare function resetExecutionCounter(sessionId: string): void;
/**
 * Get the current execution count for a session without incrementing.
 */
export declare function getExecutionCount(sessionId: string): number;
//# sourceMappingURL=tool.d.ts.map