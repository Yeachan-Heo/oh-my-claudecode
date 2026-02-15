/**
 * Codex MCP Core - Codex CLI integration
 *
 * Thin wrapper around provider-core.ts that supplies Codex-specific
 * configuration (CLI args, JSONL output parsing, error detection,
 * rate-limit backoff). All shared logic lives in provider-core.ts.
 *
 * This module is SDK-agnostic and contains no dependencies on @anthropic-ai/claude-agent-sdk.
 */
import { type RetryableErrorResult, MAX_FILE_SIZE, MAX_STDOUT_BYTES, validateModelName, computeBackoffDelay, sleep, validateAndReadFile } from './provider-core.js';
import { CODEX_MODEL_FALLBACKS } from '../features/model-routing/external-model-policy.js';
export { MAX_FILE_SIZE, MAX_STDOUT_BYTES, validateModelName, computeBackoffDelay, sleep, validateAndReadFile, };
export { CODEX_MODEL_FALLBACKS };
export declare const CODEX_DEFAULT_MODEL: string;
export declare const CODEX_TIMEOUT: number;
export declare const RATE_LIMIT_RETRY_COUNT: number;
export declare const RATE_LIMIT_INITIAL_DELAY: number;
export declare const RATE_LIMIT_MAX_DELAY: number;
export declare const CODEX_RECOMMENDED_ROLES: readonly ["architect", "planner", "critic", "analyst", "code-reviewer", "security-reviewer", "tdd-guide"];
export declare const VALID_REASONING_EFFORTS: readonly ["minimal", "low", "medium", "high", "xhigh"];
export type ReasoningEffort = typeof VALID_REASONING_EFFORTS[number];
export declare function isSpawnedPid(pid: number): boolean;
export declare function clearSpawnedPids(): void;
/** Check if Codex JSONL output contains a model-not-found error */
export declare function isModelError(output: string): {
    isError: boolean;
    message: string;
};
/** Check if output/stderr indicates a rate-limit (429) error */
export declare function isRateLimitError(output: string, stderr?: string): {
    isError: boolean;
    message: string;
};
/** Check if an error is retryable (model error OR rate limit error) */
export declare function isRetryableError(output: string, stderr?: string): RetryableErrorResult;
/**
 * Parse Codex JSONL output to extract the final text response.
 *
 * Codex CLI (--json mode) emits JSONL events. We extract text from:
 * - item.completed with item.type === "agent_message" (final response text)
 * - message events with content (string or array of {type: "text", text})
 * - output_text events with text
 */
export declare function parseCodexOutput(output: string): string;
/** Execute Codex CLI command and return the response */
export declare function executeCodex(prompt: string, model: string, cwd?: string, reasoningEffort?: ReasoningEffort): Promise<string>;
/**
 * Execute Codex CLI with model fallback chain and exponential backoff on rate limits.
 */
export declare function executeCodexWithFallback(prompt: string, model: string | undefined, cwd?: string, fallbackChain?: string[], overrides?: {
    executor?: typeof executeCodex;
    sleepFn?: typeof sleep;
}, reasoningEffort?: ReasoningEffort): Promise<{
    response: string;
    usedFallback: boolean;
    actualModel: string;
}>;
/** Execute Codex CLI in background with fallback chain */
export declare function executeCodexBackground(fullPrompt: string, modelInput: string | undefined, jobMeta: import('./prompt-persistence.js').BackgroundJobMeta, workingDirectory?: string, reasoningEffort?: ReasoningEffort): {
    pid: number;
} | {
    error: string;
};
/** Handle ask_codex tool invocation */
export declare function handleAskCodex(args: {
    prompt?: string;
    prompt_file?: string;
    output_file?: string;
    agent_role: string;
    model?: string;
    reasoning_effort?: string;
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