/**
 * Gemini MCP Core - Gemini CLI integration
 *
 * Thin wrapper around provider-core.ts that supplies Gemini-specific
 * configuration (CLI args, raw stdout output, error detection).
 * All shared logic lives in provider-core.ts.
 *
 * This module is SDK-agnostic and can be imported by both:
 * - gemini-server.ts (in-process SDK MCP server)
 * - gemini-standalone-server.ts (stdio-based external process server)
 */
import { type RetryableErrorResult, MAX_FILE_SIZE, MAX_STDOUT_BYTES, validateAndReadFile } from './provider-core.js';
export { MAX_FILE_SIZE, MAX_STDOUT_BYTES, validateAndReadFile };
export declare const GEMINI_DEFAULT_MODEL: string;
export declare const GEMINI_TIMEOUT: number;
export declare const GEMINI_RECOMMENDED_ROLES: readonly ["designer", "writer", "vision"];
export declare function isSpawnedPid(pid: number): boolean;
export declare function clearSpawnedPids(): void;
/**
 * Check if Gemini output/stderr indicates a retryable error
 * (model not found, rate-limit/429, or quota exhaustion).
 */
export declare function isGeminiRetryableError(stdout: string, stderr?: string): RetryableErrorResult;
/** Execute Gemini CLI command and return the response */
export declare function executeGemini(prompt: string, model?: string, cwd?: string): Promise<string>;
/** Execute Gemini CLI in background with fallback chain */
export declare function executeGeminiBackground(fullPrompt: string, modelInput: string | undefined, jobMeta: import('./prompt-persistence.js').BackgroundJobMeta, workingDirectory?: string): {
    pid: number;
} | {
    error: string;
};
/** Handle ask_gemini tool invocation */
export declare function handleAskGemini(args: {
    prompt?: string;
    prompt_file?: string;
    output_file?: string;
    agent_role: string;
    model?: string;
    files?: string[];
    background?: boolean;
    working_directory?: string;
}): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
//# sourceMappingURL=gemini-core.d.ts.map