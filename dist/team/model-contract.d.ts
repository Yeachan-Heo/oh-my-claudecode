import type { WorkerLaunchDescriptor } from './types.js';
export type CliAgentType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'grok' | 'antigravity';
export interface CliAgentContract {
    agentType: CliAgentType;
    binary: string;
    installInstructions: string;
    buildLaunchArgs(model?: string, extraFlags?: string[]): string[];
    parseOutput(rawOutput: string): string;
    /** Whether this agent supports a prompt/headless mode that bypasses TUI input */
    supportsPromptMode?: boolean;
    /** CLI flag for prompt mode (e.g., '-p' for gemini) */
    promptModeFlag?: string;
}
export interface WorkerLaunchConfig {
    teamName: string;
    workerName: string;
    model?: string;
    cwd: string;
    extraFlags?: string[];
    /**
     * Optional pre-validated absolute CLI binary path.
     * Used by runtime preflight validation to ensure spawns are pinned.
     */
    resolvedBinaryPath?: string;
    /**
     * Optional path the worker writes its structured verdict JSON to
     * (used by the CLI-worker output contract for critic/reviewer stages).
     * Consumed by the worker-completion handler in runtime-v2.
     */
    output_file?: string;
}
/** @deprecated Backward-compat shim for older team API consumers. */
export interface CliBinaryValidation {
    valid: boolean;
    binary: string;
    resolvedPath?: string;
    reason?: string;
}
declare function getTrustedPrefixes(): string[];
declare function isTrustedPrefix(resolvedPath: string): boolean;
/** @deprecated Backward-compat shim; non-interactive shells should generally skip RC files. */
export declare function shouldLoadShellRc(): boolean;
/** @deprecated Backward-compat shim retained for API compatibility. */
export declare function resolveCliBinaryPath(binary: string): string;
/** @deprecated Backward-compat shim retained for API compatibility. */
export declare function clearResolvedPathCache(): void;
/** @deprecated Backward-compat shim retained for API compatibility. */
export declare function validateCliBinaryPath(binary: string): CliBinaryValidation;
export declare const _testInternals: {
    UNTRUSTED_PATH_PATTERNS: RegExp[];
    getTrustedPrefixes: typeof getTrustedPrefixes;
    isTrustedPrefix: typeof isTrustedPrefix;
};
/**
 * Detect parent launch env for Claude Code API-key auth.
 *
 * Claude Code's `--dangerously-skip-permissions` only bypasses permission
 * prompts. When an API key is present, `--bare` is needed to avoid the
 * interactive OAuth/session login path for team worker panes.
 */
export declare function shouldUseClaudeBareMode(env?: NodeJS.ProcessEnv): boolean;
export declare function getContract(agentType: CliAgentType): CliAgentContract;
export declare function isCliAvailable(agentType: CliAgentType): boolean;
export declare function validateCliAvailable(agentType: CliAgentType): void;
export declare function resolveValidatedBinaryPath(agentType: CliAgentType): string;
export declare function buildLaunchArgs(agentType: CliAgentType, config: WorkerLaunchConfig): string[];
export declare function buildWorkerArgv(agentType: CliAgentType, config: WorkerLaunchConfig): string[];
export declare function validateWorkerLaunchDescriptor(value: unknown): WorkerLaunchDescriptor;
export declare function buildValidatedWorkerLaunchDescriptor(agentType: CliAgentType, config: WorkerLaunchConfig, appendedArgs?: readonly string[]): WorkerLaunchDescriptor;
export declare function buildWorkerCommand(agentType: CliAgentType, config: WorkerLaunchConfig): string;
export declare function getWorkerEnv(teamName: string, workerName: string, agentType: CliAgentType, env?: NodeJS.ProcessEnv): Record<string, string>;
export declare function parseCliOutput(agentType: CliAgentType, rawOutput: string): string;
/**
 * Check if an agent type supports prompt/headless mode (bypasses TUI).
 */
export declare function isPromptModeAgent(agentType: CliAgentType): boolean;
/**
 * Resolve the active model for Claude team workers on Bedrock/Vertex.
 *
 * When running on a non-standard provider (Bedrock, Vertex), workers need
 * the provider-specific model ID passed explicitly via --model. Without it,
 * Claude Code falls back to its built-in default (claude-sonnet-5) which
 * is invalid on these providers.
 *
 * Resolution order:
 *   1. ANTHROPIC_MODEL / CLAUDE_MODEL env vars (user's explicit setting)
 *   2. Provider tier-specific env vars (CLAUDE_CODE_BEDROCK_SONNET_MODEL, etc.)
 *   3. undefined — let Claude Code handle its own default
 *
 * Returns undefined when not on Bedrock/Vertex (standard Anthropic API
 * handles bare aliases fine).
 */
export declare function resolveClaudeWorkerModel(env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Get the extra CLI args needed to pass an instruction in prompt mode.
 * Returns empty array if the agent does not support prompt mode.
 */
/**
 * Whether a CLI agent's headless/prompt mode is supported on the given platform.
 * Antigravity (`agy`) `-p`/`--print` takes the prompt as an argv value and cannot
 * read it from stdin; on Windows that argv path is unreliable and `agy` has known
 * upstream Windows `-p` limitations. This centralizes the same platform support
 * decision the advisor (`scripts/run-provider-advisor.js`) enforces for `omc ask`.
 */
export declare function isHeadlessSupportedOnPlatform(agentType: CliAgentType, platform?: NodeJS.Platform): boolean;
/** Throw a clear, actionable error if the agent's headless mode is unsupported here. */
export declare function assertHeadlessSupported(agentType: CliAgentType): void;
export declare function getPromptModeArgs(agentType: CliAgentType, instruction: string): string[];
export {};
//# sourceMappingURL=model-contract.d.ts.map