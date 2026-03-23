/**
 * Python REPL Tool - Persistent Python execution environment
 *
 * Provides a persistent Python REPL with variable persistence across
 * tool invocations, session locking, and structured output markers.
 */
import { pythonReplHandler } from './tool.js';
export declare const pythonReplTool: {
    name: string;
    description: string;
    schema: import("zod").ZodObject<{
        action: import("zod").ZodEnum<["execute", "interrupt", "reset", "get_state"]>;
        researchSessionID: import("zod").ZodString;
        code: import("zod").ZodOptional<import("zod").ZodString>;
        executionLabel: import("zod").ZodOptional<import("zod").ZodString>;
        executionTimeout: import("zod").ZodDefault<import("zod").ZodNumber>;
        queueTimeout: import("zod").ZodDefault<import("zod").ZodNumber>;
        projectDir: import("zod").ZodOptional<import("zod").ZodString>;
    }, "strip", import("zod").ZodTypeAny, {
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
    handler: typeof pythonReplHandler;
};
export * from './types.js';
export { pythonReplSchema, pythonReplHandler } from './tool.js';
//# sourceMappingURL=index.d.ts.map