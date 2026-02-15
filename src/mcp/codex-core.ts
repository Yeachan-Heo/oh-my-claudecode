/**
 * Codex MCP Core - Codex CLI integration
 *
 * Thin wrapper around provider-core.ts that supplies Codex-specific
 * configuration (CLI args, JSONL output parsing, error detection,
 * rate-limit backoff). All shared logic lives in provider-core.ts.
 *
 * This module is SDK-agnostic and contains no dependencies on @anthropic-ai/claude-agent-sdk.
 */

import {
  // Types
  type ProviderConfig,
  type PidRegistry,
  type RetryableErrorResult,
  type ProviderAskArgs,
  // Shared constants (re-exported for backward compat)
  MAX_FILE_SIZE,
  MAX_STDOUT_BYTES,
  RATE_LIMIT_PATTERN,
  // Shared utilities (re-exported for backward compat)
  validateModelName,
  computeBackoffDelay,
  sleep,
  validateAndReadFile,
  createPidRegistry,
  // Generic execution
  executeCli,
  executeCliWithFallback,
  executeCliBackground,
  handleAskProvider,
} from './provider-core.js';
import { detectCodexCli } from './cli-detection.js';
import {
  CODEX_MODEL_FALLBACKS,
} from '../features/model-routing/external-model-policy.js';

// ─── Re-exports for backward compatibility ────────────────────────────────────

export {
  MAX_FILE_SIZE,
  MAX_STDOUT_BYTES,
  validateModelName,
  computeBackoffDelay,
  sleep,
  validateAndReadFile,
};
export { CODEX_MODEL_FALLBACKS };

// ─── Codex-specific constants ─────────────────────────────────────────────────

export const CODEX_DEFAULT_MODEL = process.env.OMC_CODEX_DEFAULT_MODEL || 'gpt-5.3-codex';
export const CODEX_TIMEOUT = Math.min(
  Math.max(5000, parseInt(process.env.OMC_CODEX_TIMEOUT || '3600000', 10) || 3600000),
  3600000,
);

export const RATE_LIMIT_RETRY_COUNT = Math.min(10, Math.max(1, parseInt(process.env.OMC_CODEX_RATE_LIMIT_RETRY_COUNT || '3', 10) || 3));
export const RATE_LIMIT_INITIAL_DELAY = Math.max(1000, parseInt(process.env.OMC_CODEX_RATE_LIMIT_INITIAL_DELAY || '5000', 10) || 5000);
export const RATE_LIMIT_MAX_DELAY = Math.max(5000, parseInt(process.env.OMC_CODEX_RATE_LIMIT_MAX_DELAY || '60000', 10) || 60000);

export const CODEX_RECOMMENDED_ROLES = ['architect', 'planner', 'critic', 'analyst', 'code-reviewer', 'security-reviewer', 'tdd-guide'] as const;

export const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = typeof VALID_REASONING_EFFORTS[number];

// ─── Module-scoped PID registry ───────────────────────────────────────────────

const codexPidRegistry: PidRegistry = createPidRegistry();

export function isSpawnedPid(pid: number): boolean {
  return codexPidRegistry.has(pid);
}

export function clearSpawnedPids(): void {
  codexPidRegistry.clear();
}

// ─── Codex-specific error detection ───────────────────────────────────────────

/** Check if Codex JSONL output contains a model-not-found error */
export function isModelError(output: string): { isError: boolean; message: string } {
  const lines = output.trim().split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'error' || event.type === 'turn.failed') {
        const msg = typeof event.message === 'string' ? event.message :
                    typeof event.error?.message === 'string' ? event.error.message : '';
        if (/model_not_found|model is not supported/i.test(msg)) {
          return { isError: true, message: msg };
        }
      }
    } catch { /* skip non-JSON lines */ }
  }
  return { isError: false, message: '' };
}

/** Check if output/stderr indicates a rate-limit (429) error */
export function isRateLimitError(output: string, stderr: string = ''): { isError: boolean; message: string } {
  const combined = `${output}\n${stderr}`;
  if (RATE_LIMIT_PATTERN.test(combined)) {
    const lines = combined.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const msg = typeof event.message === 'string' ? event.message :
                    typeof event.error?.message === 'string' ? event.error.message : '';
        if (RATE_LIMIT_PATTERN.test(msg)) {
          return { isError: true, message: msg };
        }
      } catch { /* check raw line */ }
      if (RATE_LIMIT_PATTERN.test(line)) {
        return { isError: true, message: line.trim() };
      }
    }
    return { isError: true, message: 'Rate limit error detected' };
  }
  return { isError: false, message: '' };
}

/** Check if an error is retryable (model error OR rate limit error) */
export function isRetryableError(output: string, stderr: string = ''): RetryableErrorResult {
  const modelErr = isModelError(output);
  if (modelErr.isError) {
    return { isError: true, message: modelErr.message, type: 'model' };
  }
  const rateErr = isRateLimitError(output, stderr);
  if (rateErr.isError) {
    return { isError: true, message: rateErr.message, type: 'rate_limit' };
  }
  return { isError: false, message: '', type: 'none' };
}

// ─── Codex-specific output parsing ────────────────────────────────────────────

/**
 * Parse Codex JSONL output to extract the final text response.
 *
 * Codex CLI (--json mode) emits JSONL events. We extract text from:
 * - item.completed with item.type === "agent_message" (final response text)
 * - message events with content (string or array of {type: "text", text})
 * - output_text events with text
 */
export function parseCodexOutput(output: string): string {
  const lines = output.trim().split('\n').filter(l => l.trim());
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === 'item.completed' && event.item) {
        const item = event.item;
        if (item.type === 'agent_message' && item.text) {
          messages.push(item.text);
        }
      }

      if (event.type === 'message' && event.content) {
        if (typeof event.content === 'string') {
          messages.push(event.content);
        } else if (Array.isArray(event.content)) {
          for (const part of event.content) {
            if (part.type === 'text' && part.text) {
              messages.push(part.text);
            }
          }
        }
      }

      if (event.type === 'output_text' && event.text) {
        messages.push(event.text);
      }
    } catch {
      // Skip non-JSON lines (progress indicators, etc.)
    }
  }

  return messages.join('\n') || output; // Fallback to raw output
}

// ─── Codex ProviderConfig ─────────────────────────────────────────────────────

const CODEX_CONFIG: ProviderConfig = {
  name: 'codex',
  cliCommand: 'codex',
  defaultModel: CODEX_DEFAULT_MODEL,
  timeout: CODEX_TIMEOUT,
  modelFallbacks: CODEX_MODEL_FALLBACKS,
  recommendedRoles: CODEX_RECOMMENDED_ROLES,
  fileContextParam: 'context_files',

  buildCliArgs(model: string, extra?: Record<string, unknown>): string[] {
    const args = ['exec', '-m', model, '--json', '--full-auto'];
    const re = extra?.reasoningEffort;
    if (typeof re === 'string' && VALID_REASONING_EFFORTS.includes(re as ReasoningEffort)) {
      args.push('-c', `model_reasoning_effort="${re}"`);
    }
    return args;
  },

  parseOutput: parseCodexOutput,
  detectCli: () => detectCodexCli(),
  isRetryableError,

  rateLimitConfig: {
    retryCount: RATE_LIMIT_RETRY_COUNT,
    initialDelay: RATE_LIMIT_INITIAL_DELAY,
    maxDelay: RATE_LIMIT_MAX_DELAY,
  },
};

// ─── Public API (thin wrappers) ───────────────────────────────────────────────

/** Execute Codex CLI command and return the response */
export function executeCodex(prompt: string, model: string, cwd?: string, reasoningEffort?: ReasoningEffort): Promise<string> {
  return executeCli(CODEX_CONFIG, prompt, model, cwd, reasoningEffort ? { reasoningEffort } : undefined);
}

/**
 * Execute Codex CLI with model fallback chain and exponential backoff on rate limits.
 */
export async function executeCodexWithFallback(
  prompt: string,
  model: string | undefined,
  cwd?: string,
  fallbackChain?: string[],
  overrides?: { executor?: typeof executeCodex; sleepFn?: typeof sleep },
  reasoningEffort?: ReasoningEffort,
): Promise<{ response: string; usedFallback: boolean; actualModel: string }> {
  // Adapt legacy overrides to generic signature
  const genericOverrides = overrides ? {
    ...(overrides.executor ? {
      executor: (cfg: ProviderConfig, p: string, m: string, c?: string, e?: Record<string, unknown>) =>
        overrides.executor!(p, m, c, e?.reasoningEffort as ReasoningEffort),
    } : {}),
    sleepFn: overrides.sleepFn,
  } : undefined;

  return executeCliWithFallback(
    CODEX_CONFIG, prompt, model, cwd, fallbackChain,
    reasoningEffort ? { reasoningEffort } : undefined,
    genericOverrides,
  );
}

/** Execute Codex CLI in background with fallback chain */
export function executeCodexBackground(
  fullPrompt: string,
  modelInput: string | undefined,
  jobMeta: import('./prompt-persistence.js').BackgroundJobMeta,
  workingDirectory?: string,
  reasoningEffort?: ReasoningEffort,
): { pid: number } | { error: string } {
  return executeCliBackground(
    CODEX_CONFIG, codexPidRegistry, fullPrompt, modelInput, jobMeta, workingDirectory,
    reasoningEffort ? { reasoningEffort } : undefined,
  );
}

/** Handle ask_codex tool invocation */
export async function handleAskCodex(args: {
  prompt?: string;
  prompt_file?: string;
  output_file?: string;
  agent_role: string;
  model?: string;
  reasoning_effort?: string;
  context_files?: string[];
  background?: boolean;
  working_directory?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Resolve reasoning effort (Codex-specific)
  const resolvedEffort: ReasoningEffort | undefined =
    typeof args.reasoning_effort === 'string' && VALID_REASONING_EFFORTS.includes(args.reasoning_effort as ReasoningEffort)
      ? (args.reasoning_effort as ReasoningEffort)
      : undefined;

  return handleAskProvider(CODEX_CONFIG, codexPidRegistry, {
    prompt: args.prompt,
    prompt_file: args.prompt_file,
    output_file: args.output_file,
    agent_role: args.agent_role,
    model: args.model,
    contextFiles: args.context_files,
    background: args.background,
    working_directory: args.working_directory,
    extra: resolvedEffort ? { reasoningEffort: resolvedEffort } : undefined,
    extraParamLines: resolvedEffort ? [`**Reasoning Effort:** ${resolvedEffort}`] : undefined,
  });
}
