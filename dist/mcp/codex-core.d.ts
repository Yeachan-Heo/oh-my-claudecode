/**
 * Codex MCP Core - Shared business logic for Codex CLI integration
 *
 * This module contains all the business logic for the Codex MCP integration.
 * It is imported by both the in-process SDK server (codex-server.ts) and the
 * standalone stdio server to eliminate code duplication.
 *
 * This module is SDK-agnostic and contains no dependencies on @anthropic-ai/claude-agent-sdk.
 */
import type { BackgroundJobMeta } from './prompt-persistence.js';
export declare function isSpawnedPid(pid: number): boolean;
export declare function clearSpawnedPids(): void;
export declare const CODEX_DEFAULT_MODEL: string;
export declare const CODEX_TIMEOUT: number;
export declare const CODEX_MODEL_FALLBACKS: string[];
export declare const CODEX_VALID_ROLES: readonly ["architect", "planner", "critic", "analyst", "code-reviewer", "security-reviewer", "tdd-guide"];
export declare const MAX_CONTEXT_FILES = 20;
export declare const MAX_FILE_SIZE: number;
/**
 * Check if Codex JSONL output contains a model-not-found error
 */
export declare function isModelError(output: string): {
    isError: boolean;
    message: string;
};
/**
 * Parse Codex JSONL output to extract the final text response
 *
 * Codex CLI (--json mode) emits JSONL events. We extract text from:
 * - item.completed with item.type === "agent_message" (final response text)
 * - message events with content (string or array of {type: "text", text})
 * - output_text events with text
 *
 * Note: Codex may also write to the output_file directly via shell commands.
 * If it does, callers should prefer the file content over parsed stdout.
 */
export declare function parseCodexOutput(output: string): string;
/**
 * Execute Codex CLI command and return the response
 */
export declare function executeCodex(prompt: string, model: string, cwd?: string): Promise<string>;
/**
 * Execute Codex CLI with model fallback chain
 * Only falls back on model_not_found errors when model was not explicitly provided
 */
export declare function executeCodexWithFallback(prompt: string, model: string | undefined, cwd?: string): Promise<{
    response: string;
    usedFallback: boolean;
    actualModel: string;
}>;
/**
 * Execute Codex CLI in background with fallback chain, writing status and response files upon completion
 */
export declare function executeCodexBackground(fullPrompt: string, modelInput: string | undefined, jobMeta: BackgroundJobMeta, workingDirectory?: string): {
    pid: number;
} | {
    error: string;
};
/**
 * Validate and read a file for context inclusion
 */
export declare function validateAndReadFile(filePath: string, baseDir?: string): string;
/**
 * Handle ask_codex tool invocation with all business logic
 *
 * This function contains ALL the tool handler logic and can be used by both
 * the SDK server and the standalone stdio server.
 */
export declare function handleAskCodex(args: {
    prompt_file: string;
    output_file: string;
    agent_role: string;
    model?: string;
    context_files?: string[];
    background?: boolean;
    working_directory?: string;
}): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
//# sourceMappingURL=codex-core.d.ts.map