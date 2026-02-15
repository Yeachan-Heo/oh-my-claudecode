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

import {
  // Types
  type ProviderConfig,
  type PidRegistry,
  type RetryableErrorResult,
  // Shared constants (re-exported for backward compat)
  MAX_FILE_SIZE,
  MAX_STDOUT_BYTES,
  RATE_LIMIT_PATTERN,
  // Shared utilities (re-exported for backward compat)
  validateAndReadFile,
  createPidRegistry,
  // Generic execution
  executeCli,
  executeCliBackground,
  handleAskProvider,
} from './provider-core.js';
import { detectGeminiCli } from './cli-detection.js';
import {
  GEMINI_MODEL_FALLBACKS,
} from '../features/model-routing/external-model-policy.js';

// ─── Re-exports for backward compatibility ────────────────────────────────────

export { MAX_FILE_SIZE, MAX_STDOUT_BYTES, validateAndReadFile };

// ─── Gemini-specific constants ────────────────────────────────────────────────

export const GEMINI_DEFAULT_MODEL = process.env.OMC_GEMINI_DEFAULT_MODEL || 'gemini-3-pro-preview';
export const GEMINI_TIMEOUT = Math.min(
  Math.max(5000, parseInt(process.env.OMC_GEMINI_TIMEOUT || '3600000', 10) || 3600000),
  3600000,
);

export const GEMINI_RECOMMENDED_ROLES = ['designer', 'writer', 'vision'] as const;

// ─── Module-scoped PID registry ───────────────────────────────────────────────

const geminiPidRegistry: PidRegistry = createPidRegistry();

export function isSpawnedPid(pid: number): boolean {
  return geminiPidRegistry.has(pid);
}

export function clearSpawnedPids(): void {
  geminiPidRegistry.clear();
}

// ─── Gemini-specific error detection ──────────────────────────────────────────

/**
 * Check if Gemini output/stderr indicates a retryable error
 * (model not found, rate-limit/429, or quota exhaustion).
 */
export function isGeminiRetryableError(stdout: string, stderr: string = ''): RetryableErrorResult {
  const combined = `${stdout}\n${stderr}`;
  // Check for model not found / not supported
  if (/model.?not.?found|model is not supported|model.+does not exist|not.+available/i.test(combined)) {
    const match = combined.match(/.*(?:model.?not.?found|model is not supported|model.+does not exist|not.+available).*/i);
    return { isError: true, message: match?.[0]?.trim() || 'Model not available', type: 'model' };
  }
  // Check for 429/rate limit errors
  if (RATE_LIMIT_PATTERN.test(combined)) {
    const match = combined.match(/.*(?:429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted).*/i);
    return { isError: true, message: match?.[0]?.trim() || 'Rate limit error detected', type: 'rate_limit' };
  }
  return { isError: false, message: '', type: 'none' };
}

// ─── Gemini ProviderConfig ────────────────────────────────────────────────────

const GEMINI_CONFIG: ProviderConfig = {
  name: 'gemini',
  cliCommand: 'gemini',
  defaultModel: GEMINI_DEFAULT_MODEL,
  timeout: GEMINI_TIMEOUT,
  modelFallbacks: GEMINI_MODEL_FALLBACKS,
  recommendedRoles: GEMINI_RECOMMENDED_ROLES,
  fileContextParam: 'files',

  buildCliArgs(model: string): string[] {
    return ['-p=.', '--yolo', '--model', model];
  },

  parseOutput(stdout: string): string {
    return stdout.trim();
  },

  detectCli: () => detectGeminiCli(),
  isRetryableError: isGeminiRetryableError,

  // No rateLimitConfig: Gemini retries are immediate (no backoff)
};

// ─── Public API (thin wrappers) ───────────────────────────────────────────────

/** Execute Gemini CLI command and return the response */
export function executeGemini(prompt: string, model?: string, cwd?: string): Promise<string> {
  return executeCli(GEMINI_CONFIG, prompt, model || GEMINI_DEFAULT_MODEL, cwd);
}

/** Execute Gemini CLI in background with fallback chain */
export function executeGeminiBackground(
  fullPrompt: string,
  modelInput: string | undefined,
  jobMeta: import('./prompt-persistence.js').BackgroundJobMeta,
  workingDirectory?: string,
): { pid: number } | { error: string } {
  return executeCliBackground(GEMINI_CONFIG, geminiPidRegistry, fullPrompt, modelInput, jobMeta, workingDirectory);
}

/** Handle ask_gemini tool invocation */
export async function handleAskGemini(args: {
  prompt?: string;
  prompt_file?: string;
  output_file?: string;
  agent_role: string;
  model?: string;
  files?: string[];
  background?: boolean;
  working_directory?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return handleAskProvider(GEMINI_CONFIG, geminiPidRegistry, {
    prompt: args.prompt,
    prompt_file: args.prompt_file,
    output_file: args.output_file,
    agent_role: args.agent_role,
    model: args.model,
    contextFiles: args.files,
    background: args.background,
    working_directory: args.working_directory,
  });
}
