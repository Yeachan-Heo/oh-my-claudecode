/**
 * Gemini Core Business Logic - Shared between SDK and Standalone MCP servers
 *
 * This module contains all the business logic for Gemini CLI integration:
 * - Constants and configuration
 * - CLI execution with timeout handling
 * - File validation and reading
 * - Complete tool handler logic with role validation, fallback chain, etc.
 *
 * This module is SDK-agnostic and can be imported by both:
 * - gemini-server.ts (in-process SDK MCP server)
 * - gemini-standalone-server.ts (stdio-based external process server)
 */
import type { BackgroundJobMeta } from './prompt-persistence.js';
export declare function isSpawnedPid(pid: number): boolean;
export declare function clearSpawnedPids(): void;
export declare const GEMINI_DEFAULT_MODEL: string;
export declare const GEMINI_TIMEOUT: number;
export declare const GEMINI_RECOMMENDED_ROLES: readonly ["designer", "writer", "vision"];
export declare const MAX_FILE_SIZE: number;
export declare const MAX_STDOUT_BYTES: number;
/**
 * Check if Gemini output/stderr indicates a rate-limit (429) or quota error
 * that should trigger a fallback to the next model in the chain.
 */
export declare function isGeminiRetryableError(stdout: string, stderr?: string): {
    isError: boolean;
    message: string;
    type: 'rate_limit' | 'model' | 'none';
};
/**
 * Execute Gemini CLI command and return the response
 */
export declare function executeGemini(prompt: string, model?: string, cwd?: string): Promise<string>;
/**
 * Execute Gemini CLI in background with fallback chain support
 * Retries with next model on model errors and 429/rate-limit errors
 */
export declare function executeGeminiBackground(fullPrompt: string, modelInput: string | undefined, jobMeta: BackgroundJobMeta, workingDirectory?: string): {
    pid: number;
} | {
    error: string;
};
/**
 * Validate and read a file for context inclusion
 */
export declare function validateAndReadFile(filePath: string, baseDir?: string): string;
/**
 * Handle ask_gemini tool request - contains ALL business logic
 *
 * This function is called by both the SDK server and standalone server.
 * It performs:
 * - Agent role validation
 * - CLI detection
 * - System prompt resolution
 * - File context building
 * - Full prompt assembly
 * - Fallback chain execution
 * - Error handling
 *
 * @returns MCP-compatible response with content array
 */
export declare function handleAskGemini(args: {
    prompt_file: string;
    output_file: string;
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