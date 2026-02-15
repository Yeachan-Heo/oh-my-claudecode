/**
 * Provider Core - Shared business logic for MCP CLI provider integration
 *
 * Extracts the common patterns between codex-core.ts and gemini-core.ts
 * into a single parameterized implementation. Each provider defines a
 * ProviderConfig with its CLI-specific differences; the generic functions
 * handle execution, fallback chains, background jobs, and the full
 * handleAsk flow.
 */
import type { CliDetectionResult } from './cli-detection.js';
import type { BackgroundJobMeta } from './prompt-persistence.js';
export declare const MODEL_NAME_REGEX: RegExp;
export declare const MAX_FILE_SIZE: number;
export declare const MAX_STDOUT_BYTES: number;
export declare const PLATFORM_SHELL_OPTS: Record<string, boolean>;
export declare const RATE_LIMIT_PATTERN: RegExp;
export declare function validateModelName(model: string): void;
/**
 * Compute exponential backoff delay with jitter for rate limit retries.
 * Returns delay in ms: min(initialDelay * 2^attempt, maxDelay) * random(0.5, 1.0)
 */
export declare function computeBackoffDelay(attempt: number, initialDelay: number, maxDelay: number): number;
/** Sleep for the specified duration. Exported for test mockability. */
export declare function sleep(ms: number): Promise<void>;
export interface PidRegistry {
    add(pid: number): void;
    delete(pid: number): void;
    has(pid: number): boolean;
    clear(): void;
}
export declare function createPidRegistry(): PidRegistry;
export declare function validateAndReadFile(filePath: string, baseDir?: string): string;
export type ProviderName = 'codex' | 'gemini';
export type RetryableErrorResult = {
    isError: boolean;
    message: string;
    type: 'model' | 'rate_limit' | 'none';
};
export interface ProviderConfig {
    name: ProviderName;
    cliCommand: string;
    defaultModel: string;
    timeout: number;
    modelFallbacks: string[];
    recommendedRoles: readonly string[];
    /** Parameter name used for file context in the tool schema (e.g. 'context_files' or 'files') */
    fileContextParam: string;
    /** Build CLI args for a given model. `extra` carries provider-specific options. */
    buildCliArgs(model: string, extra?: Record<string, unknown>): string[];
    /** Transform raw stdout into the response string. */
    parseOutput(stdout: string): string;
    /** Detect whether the CLI binary is available. */
    detectCli(): CliDetectionResult;
    /** Classify stdout/stderr as retryable (model or rate-limit) error. */
    isRetryableError(stdout: string, stderr: string): RetryableErrorResult;
    /** Rate-limit backoff config. When absent, retries are immediate. */
    rateLimitConfig?: {
        retryCount: number;
        initialDelay: number;
        maxDelay: number;
    };
}
/**
 * Execute a provider CLI command synchronously (waits for completion).
 */
export declare function executeCli(config: ProviderConfig, prompt: string, model: string, cwd?: string, extra?: Record<string, unknown>): Promise<string>;
export declare function executeCliWithFallback(config: ProviderConfig, prompt: string, model: string | undefined, cwd?: string, fallbackChain?: string[], extra?: Record<string, unknown>, overrides?: {
    executor?: (cfg: ProviderConfig, p: string, m: string, c?: string, e?: Record<string, unknown>) => Promise<string>;
    sleepFn?: typeof sleep;
}): Promise<{
    response: string;
    usedFallback: boolean;
    actualModel: string;
}>;
export declare function executeCliBackground(config: ProviderConfig, pidRegistry: PidRegistry, fullPrompt: string, modelInput: string | undefined, jobMeta: BackgroundJobMeta, workingDirectory?: string, extra?: Record<string, unknown>): {
    pid: number;
} | {
    error: string;
};
export interface ProviderAskArgs {
    prompt?: string;
    prompt_file?: string;
    output_file?: string;
    agent_role: string;
    model?: string;
    contextFiles?: string[];
    background?: boolean;
    working_directory?: string;
    /** Provider-specific options (e.g. reasoningEffort for Codex) */
    extra?: Record<string, unknown>;
    /** Extra lines to include in the parameter visibility block */
    extraParamLines?: string[];
}
type McpResponse = {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
};
/**
 * Generic tool handler for ask_codex / ask_gemini.
 *
 * Contains ALL the shared business logic: working-directory validation,
 * worktree boundary checks, agent-role validation, inline-prompt handling,
 * prompt-file resolution, CLI detection, system-prompt resolution,
 * file-context building, prompt persistence, background dispatch,
 * foreground execution with fallback, response persistence, and output-file writing.
 */
export declare function handleAskProvider(config: ProviderConfig, pidRegistry: PidRegistry, args: ProviderAskArgs): Promise<McpResponse>;
export {};
//# sourceMappingURL=provider-core.d.ts.map