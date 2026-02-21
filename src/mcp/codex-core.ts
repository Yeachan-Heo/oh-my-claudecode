/**
 * Codex MCP Core - Shared business logic for Codex CLI integration
 *
 * This module contains all the business logic for the Codex MCP integration.
 * It is imported by both the in-process SDK server (codex-server.ts) and the
 * standalone stdio server to eliminate code duplication.
 *
 * This module is SDK-agnostic and contains no dependencies on @anthropic-ai/claude-agent-sdk.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve, relative, sep, isAbsolute, basename, join } from 'path';
import { createStdoutCollector, safeWriteOutputFile } from './shared-exec.js';
import { detectCodexCli } from './cli-detection.js';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { isExternalPromptAllowed } from './mcp-config.js';
import { resolveSystemPrompt, buildPromptWithSystemContext, wrapUntrustedFileContent, wrapUntrustedCliResponse, isValidAgentRoleName, VALID_AGENT_ROLES, singleErrorBlock, inlineSuccessBlocks } from './prompt-injection.js';
import { persistPrompt, persistResponse, getExpectedResponsePath, getPromptsDir, slugify, generatePromptId } from './prompt-persistence.js';
import { writeJobStatus, getStatusFilePath, readJobStatus } from './prompt-persistence.js';
import type { JobStatus, BackgroundJobMeta } from './prompt-persistence.js';
import {
  resolveExternalModel,
  buildFallbackChain,
  CODEX_MODEL_FALLBACKS,
} from '../features/model-routing/external-model-policy.js';
import { loadConfig } from '../config/loader.js';

// Module-scoped PID registry - tracks PIDs spawned by this process
const spawnedPids = new Set<number>();

export function isSpawnedPid(pid: number): boolean {
  return spawnedPids.has(pid);
}

export function clearSpawnedPids(): void {
  spawnedPids.clear();
}

// Model name validation: alphanumeric start, then alphanumeric/dots/hyphens/underscores, max 64 chars
const MODEL_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function validateModelName(model: string): void {
  if (!MODEL_NAME_REGEX.test(model)) {
    throw new Error(`Invalid model name: "${model}". Model names must match pattern: alphanumeric start, followed by alphanumeric, dots, hyphens, or underscores (max 64 chars).`);
  }
}

// Default model can be overridden via environment variable
export const CODEX_DEFAULT_MODEL = process.env.OMC_CODEX_DEFAULT_MODEL || 'gpt-5.3-codex';
export const CODEX_TIMEOUT = Math.min(Math.max(5000, parseInt(process.env.OMC_CODEX_TIMEOUT || '3600000', 10) || 3600000), 3600000);

// Rate limit backoff configuration (configurable via environment variables)
export const RATE_LIMIT_RETRY_COUNT = Math.min(10, Math.max(1, parseInt(process.env.OMC_CODEX_RATE_LIMIT_RETRY_COUNT || '3', 10) || 3));
export const RATE_LIMIT_INITIAL_DELAY = Math.max(1000, parseInt(process.env.OMC_CODEX_RATE_LIMIT_INITIAL_DELAY || '5000', 10) || 5000);
export const RATE_LIMIT_MAX_DELAY = Math.max(5000, parseInt(process.env.OMC_CODEX_RATE_LIMIT_MAX_DELAY || '60000', 10) || 60000);

// Re-export CODEX_MODEL_FALLBACKS for backward compatibility
export { CODEX_MODEL_FALLBACKS };

// Codex is best for analytical/planning tasks (recommended, not enforced)
export const CODEX_RECOMMENDED_ROLES = ['architect', 'planner', 'critic', 'analyst', 'code-reviewer', 'security-reviewer', 'test-engineer'] as const;

// Valid reasoning effort levels for Codex CLI (via -c model_reasoning_effort=<value>)
// Default (when omitted): inherits from ~/.codex/config.toml (Codex CLI default is "medium")
export const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = typeof VALID_REASONING_EFFORTS[number];

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
export const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10MB stdout cap

/**
 * Compute exponential backoff delay with jitter for rate limit retries.
 * Returns delay in ms: min(initialDelay * 2^attempt, maxDelay) * random(0.5, 1.0)
 */
export function computeBackoffDelay(
  attempt: number,
  initialDelay: number = RATE_LIMIT_INITIAL_DELAY,
  maxDelay: number = RATE_LIMIT_MAX_DELAY,
): number {
  const exponential = initialDelay * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelay);
  const jitter = capped * (0.5 + Math.random() * 0.5);
  return Math.round(jitter);
}

/**
 * Sleep for the specified duration. Exported for test mockability.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if Codex JSONL output contains a model-not-found error
 */
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

/**
 * Check if an error message or output indicates a rate-limit (429) error
 * that should trigger a fallback to the next model in the chain.
 */
export function isRateLimitError(output: string, stderr: string = ''): { isError: boolean; message: string } {
  const combined = `${output}\n${stderr}`;
  // Check for 429 status codes and rate limit messages in both stdout and stderr
  if (/429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(combined)) {
    // Extract a meaningful message
    const lines = combined.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const msg = typeof event.message === 'string' ? event.message :
                    typeof event.error?.message === 'string' ? event.error.message : '';
        if (/429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(msg)) {
          return { isError: true, message: msg };
        }
      } catch { /* check raw line */ }
      if (/429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(line)) {
        return { isError: true, message: line.trim() };
      }
    }
    return { isError: true, message: 'Rate limit error detected' };
  }
  return { isError: false, message: '' };
}

/**
 * Check if an error is retryable (model error OR rate limit error)
 */
export function isRetryableError(output: string, stderr: string = ''): { isError: boolean; message: string; type: 'model' | 'rate_limit' | 'none' } {
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
export function parseCodexOutput(output: string): string {
  const lines = output.trim().split('\n').filter(l => l.trim());
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // Handle item.completed events (primary format from current Codex CLI)
      if (event.type === 'item.completed' && event.item) {
        const item = event.item;
        // agent_message contains the final response text
        if (item.type === 'agent_message' && item.text) {
          messages.push(item.text);
        }
      }

      // Handle message events with text content (older/alternative format)
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

      // Handle output_text events
      if (event.type === 'output_text' && event.text) {
        messages.push(event.text);
      }
    } catch {
      // Skip non-JSON lines (progress indicators, etc.)
    }
  }

  return messages.join('\n') || output; // Fallback to raw output
}

/**
 * Execute Codex CLI command and return the response
 */
export function executeCodex(prompt: string, model: string, cwd?: string, reasoningEffort?: ReasoningEffort): Promise<string> {
  return new Promise((resolve, reject) => {
    validateModelName(model);
    let settled = false;
    const args = ['exec', '-m', model, '--json', '--full-auto'];
    // Per-call reasoning effort override via Codex CLI -c flag
    if (reasoningEffort && VALID_REASONING_EFFORTS.includes(reasoningEffort)) {
      args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
    }
    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      // shell: true needed on Windows for .cmd/.bat executables.
      // Safe: args are array-based and model names are regex-validated.
      ...(process.platform === 'win32' ? { shell: true } : {})
    });

    // Manual timeout handling to ensure proper cleanup
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Codex timed out after ${CODEX_TIMEOUT}ms`));
      }
    }, CODEX_TIMEOUT);

    const collector = createStdoutCollector(MAX_STDOUT_BYTES);
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      collector.append(data.toString());
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        const stdout = collector.toString();
        if (code === 0 || stdout.trim()) {
          const retryable = isRetryableError(stdout, stderr);
          if (retryable.isError) {
            reject(new Error(`Codex ${retryable.type === 'rate_limit' ? 'rate limit' : 'model'} error: ${retryable.message}`));
          } else {
            resolve(parseCodexOutput(stdout));
          }
        } else {
          // Check stderr for rate limit errors before generic failure
          const retryableExit = isRateLimitError(stderr, stdout);
          if (retryableExit.isError) {
            reject(new Error(`Codex rate limit error: ${retryableExit.message}`));
          } else {
            reject(new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`));
          }
        }
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        child.kill('SIGTERM');
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      }
    });

    // Pipe prompt via stdin with error handling
    child.stdin.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        child.kill('SIGTERM');
        reject(new Error(`Stdin write error: ${err.message}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Execute Codex CLI with model fallback chain and exponential backoff on rate limits.
 * Falls back on model_not_found or rate limit errors when model was not explicitly provided.
 * When model IS explicit, retries the same model with backoff on rate limit.
 */
export async function executeCodexWithFallback(
  prompt: string,
  model: string | undefined,
  cwd?: string,
  fallbackChain?: string[],
  /** @internal Testing overrides */
  overrides?: { executor?: typeof executeCodex; sleepFn?: typeof sleep },
  reasoningEffort?: ReasoningEffort,
): Promise<{ response: string; usedFallback: boolean; actualModel: string }> {
  const exec = overrides?.executor ?? executeCodex;
  const sleepFn = overrides?.sleepFn ?? sleep;
  const modelExplicit = model !== undefined && model !== null && model !== '';
  const effectiveModel = model || CODEX_DEFAULT_MODEL;

  // If model was explicitly provided, retry with backoff on rate limit (no fallback chain)
  if (modelExplicit) {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_COUNT; attempt++) {
      try {
        const response = await exec(prompt, effectiveModel, cwd, reasoningEffort);
        return { response, usedFallback: false, actualModel: effectiveModel };
      } catch (err) {
        lastError = err as Error;
        if (!/429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(lastError.message)) {
          throw lastError; // Non-rate-limit error, throw immediately
        }
        if (attempt < RATE_LIMIT_RETRY_COUNT) {
          const delay = computeBackoffDelay(attempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
          await sleepFn(delay);
        }
      }
    }
    throw lastError || new Error('Codex rate limit: all retries exhausted');
  }

  // Use provided fallback chain or build from defaults
  const chain = fallbackChain || CODEX_MODEL_FALLBACKS;
  const modelsToTry = chain.includes(effectiveModel)
    ? chain.slice(chain.indexOf(effectiveModel))
    : [effectiveModel, ...chain];

  let lastError: Error | null = null;
  let rateLimitAttempt = 0;
  for (const tryModel of modelsToTry) {
    try {
      const response = await exec(prompt, tryModel, cwd, reasoningEffort);
      return {
        response,
        usedFallback: tryModel !== effectiveModel,
        actualModel: tryModel,
      };
    } catch (err) {
      lastError = err as Error;
      // Retry on model errors and rate limit errors
      if (!/model error|model_not_found|model is not supported|429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(lastError.message)) {
        throw lastError; // Non-retryable error, don't retry
      }
      // Add backoff delay for rate limit errors before trying next model
      if (/429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(lastError.message)) {
        const delay = computeBackoffDelay(rateLimitAttempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
        await sleepFn(delay);
        rateLimitAttempt++;
      }
      // Continue to next model in chain (no delay for model errors)
    }
  }

  throw lastError || new Error('All Codex models in fallback chain failed');
}

/**
 * Execute Codex CLI in background with fallback chain, writing status and response files upon completion
 */
export function executeCodexBackground(
  fullPrompt: string,
  modelInput: string | undefined,
  jobMeta: BackgroundJobMeta,
  workingDirectory?: string,
  reasoningEffort?: ReasoningEffort,
): { pid: number } | { error: string } {
  try {
    const modelExplicit = modelInput !== undefined && modelInput !== null && modelInput !== '';
    const effectiveModel = modelInput || CODEX_DEFAULT_MODEL;

    // Build fallback chain
    const modelsToTry = modelExplicit
      ? [effectiveModel] // No fallback if model explicitly provided
      : (CODEX_MODEL_FALLBACKS.includes(effectiveModel)
          ? CODEX_MODEL_FALLBACKS.slice(CODEX_MODEL_FALLBACKS.indexOf(effectiveModel))
          : [effectiveModel, ...CODEX_MODEL_FALLBACKS]);

    // Helper to try spawning with a specific model
    const trySpawnWithModel = (tryModel: string, remainingModels: string[], rateLimitAttempt: number = 0): { pid: number } | { error: string } => {
      validateModelName(tryModel);
      const args = ['exec', '-m', tryModel, '--json', '--full-auto'];
      // Per-call reasoning effort override for background execution
      if (reasoningEffort && VALID_REASONING_EFFORTS.includes(reasoningEffort)) {
        args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
      }
      const child = spawn('codex', args, {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(workingDirectory ? { cwd: workingDirectory } : {}),
        // shell: true needed on Windows for .cmd/.bat executables.
        // Safe: args are array-based and model names are regex-validated.
        ...(process.platform === 'win32' ? { shell: true } : {})
      });

      if (!child.pid) {
        return { error: 'Failed to get process ID' };
      }

      const pid = child.pid;
      spawnedPids.add(pid);
      child.unref();

      // Write initial spawned status
      const initialStatus: JobStatus = {
        provider: 'codex',
        jobId: jobMeta.jobId,
        slug: jobMeta.slug,
        status: 'spawned',
        pid,
        promptFile: jobMeta.promptFile,
        responseFile: jobMeta.responseFile,
        model: tryModel,
        agentRole: jobMeta.agentRole,
        spawnedAt: new Date().toISOString(),
      };
      writeJobStatus(initialStatus, workingDirectory);

      const collector = createStdoutCollector(MAX_STDOUT_BYTES);
      let stderr = '';
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          spawnedPids.delete(pid);
          try {
            // Detached children are process-group leaders on POSIX.
            if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
            else child.kill('SIGTERM');
          } catch {
            // ignore
          }
          writeJobStatus({
            ...initialStatus,
            status: 'timeout',
            completedAt: new Date().toISOString(),
            error: `Codex timed out after ${CODEX_TIMEOUT}ms`,
          }, workingDirectory);
        }
      }, CODEX_TIMEOUT);

      child.stdout?.on('data', (data: Buffer) => {
        collector.append(data.toString());
      });
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      // Update to running after stdin write
      child.stdin?.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        writeJobStatus({
          ...initialStatus,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: `Stdin write error: ${err.message}`,
        }, workingDirectory);
      });
      child.stdin?.write(fullPrompt);
      child.stdin?.end();
      writeJobStatus({ ...initialStatus, status: 'running' }, workingDirectory);

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        spawnedPids.delete(pid);
        const stdout = collector.toString();

        // Check if user killed this job - if so, don't overwrite the killed status
        const currentStatus = readJobStatus('codex', jobMeta.slug, jobMeta.jobId, workingDirectory);
        if (currentStatus?.killedByUser) {
          return; // Status already set by kill_job, don't overwrite
        }

        if (code === 0 || stdout.trim()) {
          // Check for retryable errors (model errors + rate limit/429 errors)
          const retryableErr = isRetryableError(stdout, stderr);
          if (retryableErr.isError) {
            const isRateLimit = retryableErr.type === 'rate_limit';

            // Rate limit with explicit model: retry same model with backoff
            if (isRateLimit && modelExplicit && rateLimitAttempt < RATE_LIMIT_RETRY_COUNT) {
              const delay = computeBackoffDelay(rateLimitAttempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
              setTimeout(() => {
                const retryResult = trySpawnWithModel(tryModel, remainingModels, rateLimitAttempt + 1);
                if ('error' in retryResult) {
                  writeJobStatus({
                    ...initialStatus,
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: `Rate limit retry failed for model ${tryModel}: ${retryResult.error}`,
                  }, workingDirectory);
                }
              }, delay);
              return;
            }

            // Fallback chain: try next model (with backoff for rate limit, immediate for model errors)
            if (remainingModels.length > 0) {
              const nextModel = remainingModels[0];
              const newRemainingModels = remainingModels.slice(1);
              if (isRateLimit) {
                const delay = computeBackoffDelay(rateLimitAttempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
                setTimeout(() => {
                  const retryResult = trySpawnWithModel(nextModel, newRemainingModels, rateLimitAttempt + 1);
                  if ('error' in retryResult) {
                    writeJobStatus({
                      ...initialStatus,
                      status: 'failed',
                      completedAt: new Date().toISOString(),
                      error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                    }, workingDirectory);
                  }
                }, delay);
              } else {
                const retryResult = trySpawnWithModel(nextModel, newRemainingModels, rateLimitAttempt);
                if ('error' in retryResult) {
                  writeJobStatus({
                    ...initialStatus,
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                  }, workingDirectory);
                }
              }
              return;
            }

            // No remaining models and no retries left
            writeJobStatus({
              ...initialStatus,
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: `All models in fallback chain failed. Last error (${retryableErr.type}): ${retryableErr.message}`,
            }, workingDirectory);
            return;
          }

          const response = parseCodexOutput(stdout);
          const usedFallback = tryModel !== effectiveModel;
          persistResponse({
            provider: 'codex',
            agentRole: jobMeta.agentRole,
            model: tryModel,
            promptId: jobMeta.jobId,
            slug: jobMeta.slug,
            response,
            workingDirectory,
            usedFallback,
            fallbackModel: usedFallback ? tryModel : undefined,
          });
          writeJobStatus({
            ...initialStatus,
            model: tryModel,
            status: 'completed',
            completedAt: new Date().toISOString(),
            usedFallback: usedFallback || undefined,
            fallbackModel: usedFallback ? tryModel : undefined,
          }, workingDirectory);
        } else {
          // Check if the failure is a retryable error (429/rate limit) before giving up
          const retryableExit = isRetryableError(stderr, stdout);
          if (retryableExit.isError) {
            const isRateLimit = retryableExit.type === 'rate_limit';

            // Rate limit with explicit model: retry same model with backoff
            if (isRateLimit && modelExplicit && rateLimitAttempt < RATE_LIMIT_RETRY_COUNT) {
              const delay = computeBackoffDelay(rateLimitAttempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
              setTimeout(() => {
                const retryResult = trySpawnWithModel(tryModel, remainingModels, rateLimitAttempt + 1);
                if ('error' in retryResult) {
                  writeJobStatus({
                    ...initialStatus,
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: `Rate limit retry failed for model ${tryModel}: ${retryResult.error}`,
                  }, workingDirectory);
                }
              }, delay);
              return;
            }

            // Fallback chain: try next model (with backoff for rate limit, immediate for model errors)
            if (remainingModels.length > 0) {
              const nextModel = remainingModels[0];
              const newRemainingModels = remainingModels.slice(1);
              if (isRateLimit) {
                const delay = computeBackoffDelay(rateLimitAttempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
                setTimeout(() => {
                  const retryResult = trySpawnWithModel(nextModel, newRemainingModels, rateLimitAttempt + 1);
                  if ('error' in retryResult) {
                    writeJobStatus({
                      ...initialStatus,
                      status: 'failed',
                      completedAt: new Date().toISOString(),
                      error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                    }, workingDirectory);
                  }
                }, delay);
              } else {
                const retryResult = trySpawnWithModel(nextModel, newRemainingModels, rateLimitAttempt);
                if ('error' in retryResult) {
                  writeJobStatus({
                    ...initialStatus,
                    status: 'failed',
                    completedAt: new Date().toISOString(),
                    error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                  }, workingDirectory);
                }
              }
              return;
            }
          }
          writeJobStatus({
            ...initialStatus,
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: `Codex exited with code ${code}: ${stderr || 'No output'}`,
          }, workingDirectory);
        }
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        writeJobStatus({
          ...initialStatus,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: `Failed to spawn Codex CLI: ${err.message}`,
        }, workingDirectory);
      });

      return { pid };
    };

    // Start execution with the first model in the chain
    return trySpawnWithModel(modelsToTry[0], modelsToTry.slice(1));
  } catch (err) {
    return { error: `Failed to start background execution: ${(err as Error).message}` };
  }
}

/**
 * Validate and read a file for context inclusion
 */
export function validateAndReadFile(filePath: string, baseDir?: string): string {
  if (typeof filePath !== 'string') {
    return `--- File: ${filePath} --- (Invalid path type)`;
  }
  try {
    const workingDir = baseDir || process.cwd();
    const resolvedAbs = resolve(workingDir, filePath);

    // Security: ensure file is within working directory (worktree boundary)
    const cwdReal = realpathSync(workingDir);

    const relAbs = relative(cwdReal, resolvedAbs);
    if (relAbs === '..' || relAbs.startsWith('..' + sep) || isAbsolute(relAbs)) {
      return `[BLOCKED] File '${filePath}' is outside the working directory. Only files within the project are allowed.`;
    }

    // Symlink-safe check: ensure the real path also stays inside the boundary.
    const resolvedReal = realpathSync(resolvedAbs);
    const relReal = relative(cwdReal, resolvedReal);
    if (relReal === '..' || relReal.startsWith('..' + sep) || isAbsolute(relReal)) {
      return `[BLOCKED] File '${filePath}' is outside the working directory. Only files within the project are allowed.`;
    }

    const stats = statSync(resolvedReal);
    if (!stats.isFile()) {
      return `--- File: ${filePath} --- (Not a regular file)`;
    }
    if (stats.size > MAX_FILE_SIZE) {
      return `--- File: ${filePath} --- (File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB, max 5MB)`;
    }
    return wrapUntrustedFileContent(filePath, readFileSync(resolvedReal, 'utf-8'));
  } catch {
    return `--- File: ${filePath} --- (Error reading file)`;
  }
}

/**
 * Handle ask_codex tool invocation with all business logic
 *
 * This function contains ALL the tool handler logic and can be used by both
 * the SDK server and the standalone stdio server.
 */
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
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return singleErrorBlock('Invalid request: args must be an object.');
  }

  const { agent_role, context_files } = args;

  // Resolve reasoning effort: explicit parameter takes precedence, otherwise omit (use CLI default)
  const resolvedEffort: ReasoningEffort | undefined =
    typeof args.reasoning_effort === 'string' && VALID_REASONING_EFFORTS.includes(args.reasoning_effort as ReasoningEffort)
      ? (args.reasoning_effort as ReasoningEffort)
      : undefined;

  // Resolve model based on configuration and agent role
  const config = loadConfig();
  const resolved = resolveExternalModel(config.externalModels, {
    agentRole: args.agent_role,
    explicitProvider: 'codex',
    explicitModel: args.model,  // user explicitly passed model
  });

  // Build fallback chain with resolved model as first candidate
  const fallbackChain = buildFallbackChain('codex', resolved.model, config.externalModels);

  // Use resolved model (with env var fallback for backward compatibility)
  const model = resolved.model || CODEX_DEFAULT_MODEL;

  // Derive baseDir from working_directory if provided
  let baseDir = args.working_directory || process.cwd();
  let baseDirReal: string;
  const pathPolicy = process.env.OMC_ALLOW_EXTERNAL_WORKDIR === '1' ? 'permissive' : 'strict';
  try {
    baseDirReal = realpathSync(baseDir);
    baseDir = baseDirReal;
  } catch (err) {
    const errorToken = 'E_WORKDIR_INVALID';
    return singleErrorBlock(`${errorToken}: working_directory '${args.working_directory}' does not exist or is not accessible.
Error: ${(err as Error).message}
Resolved working directory: ${baseDir}
Path policy: ${pathPolicy}
Suggested: ensure the working directory exists and is accessible`);
  }

  // Security: validate working_directory is within worktree (unless bypass enabled)
  if (pathPolicy === 'strict') {
    const worktreeRoot = getWorktreeRoot(baseDirReal);
    if (worktreeRoot) {
      let worktreeReal: string;
      try {
        worktreeReal = realpathSync(worktreeRoot);
      } catch {
        // If worktree root can't be resolved, skip boundary check rather than break
        worktreeReal = '';
      }
      if (worktreeReal) {
        const relToWorktree = relative(worktreeReal, baseDirReal);
        if (relToWorktree.startsWith('..') || isAbsolute(relToWorktree)) {
          const errorToken = 'E_WORKDIR_INVALID';
          return singleErrorBlock(`${errorToken}: working_directory '${args.working_directory}' is outside the project worktree (${worktreeRoot}).
Requested: ${args.working_directory}
Resolved working directory: ${baseDirReal}
Worktree root: ${worktreeRoot}
Path policy: ${pathPolicy}
Suggested: use a working_directory within the project worktree, or set OMC_ALLOW_EXTERNAL_WORKDIR=1 to bypass`);
        }
      }
    }
  }


  // Validate agent_role - must be non-empty and pass character validation
  if (typeof agent_role !== 'string' || !agent_role.trim()) {
    return singleErrorBlock('agent_role is required and must be a non-empty string.');
  }
  if (!isValidAgentRoleName(agent_role)) {
    return singleErrorBlock(`Invalid agent_role: "${agent_role}". Role names must contain only lowercase letters, numbers, and hyphens. Recommended for Codex: ${CODEX_RECOMMENDED_ROLES.join(', ')}`);
  }
  // Validate agent_role exists in discovered roles (allowlist enforcement)
  if (!VALID_AGENT_ROLES.includes(agent_role)) {
    return singleErrorBlock(`Unknown agent_role: "${agent_role}". Available roles: ${VALID_AGENT_ROLES.join(', ')}. Recommended for Codex: ${CODEX_RECOMMENDED_ROLES.join(', ')}`);
  }

  // Determine inline intent: caller provided `prompt` field without a defined `prompt_file` field.
  // Defined-value precedence: if `prompt_file` key exists with a non-undefined value, file mode wins.
  // This handles JSON-RPC serializers that emit `prompt_file: undefined` as "not provided".
  // Separate intent detection (field presence) from content validation (non-empty).
  const inlinePrompt = typeof args.prompt === 'string' ? args.prompt : undefined;
  const hasPromptFileField = Object.prototype.hasOwnProperty.call(args, 'prompt_file') && args.prompt_file !== undefined;
  const promptFileInput = hasPromptFileField && typeof args.prompt_file === 'string' ? args.prompt_file.trim() || undefined : undefined;
  let resolvedPromptFile = promptFileInput;
  let resolvedOutputFile = typeof args.output_file === 'string' ? args.output_file : undefined;
  const hasInlineIntent = inlinePrompt !== undefined && !hasPromptFileField;
  const isInlineMode = hasInlineIntent && inlinePrompt.trim().length > 0;

  // Reject empty/whitespace inline prompt with explicit error BEFORE any side effects
  if (hasInlineIntent && !inlinePrompt?.trim()) {
    return singleErrorBlock('Inline prompt is empty. Provide a non-empty prompt string.');
  }

  // Reject oversized inline prompts before any persistence
  const MAX_INLINE_PROMPT_BYTES = 256 * 1024; // 256 KB
  if (isInlineMode && Buffer.byteLength(inlinePrompt as string, 'utf-8') > MAX_INLINE_PROMPT_BYTES) {
    return singleErrorBlock(`Inline prompt exceeds maximum size (${MAX_INLINE_PROMPT_BYTES} bytes). Use prompt_file for large prompts.`);
  }

  // Inline mode is foreground only - check BEFORE any file persistence to avoid leaks
  if (isInlineMode && args.background) {
    return singleErrorBlock('Inline prompt mode is foreground only. Use prompt_file for background execution.');
  }

  // Explicit type error for non-string prompt_file (e.g., null, number, object)
  if (hasPromptFileField && !promptFileInput) {
    return singleErrorBlock('prompt_file must be a non-empty string when provided. Received non-string or empty value.');
  }

  let inlineRequestId: string | undefined;

  // Handle inline prompt: auto-persist to file for audit trail
  if (isInlineMode) {
    inlineRequestId = generatePromptId();
    try {
      const promptsDir = getPromptsDir(baseDir);
      mkdirSync(promptsDir, { recursive: true });
      const slug = slugify(inlinePrompt as string);
      const inlinePromptFile = join(promptsDir, `codex-inline-${slug}-${inlineRequestId}.md`);
      writeFileSync(inlinePromptFile, inlinePrompt as string, { encoding: 'utf-8', mode: 0o600 });
      const resolvedPromptFileLocal = inlinePromptFile;
      const resolvedOutputFileLocal = (!resolvedOutputFile || !resolvedOutputFile.trim())
        ? join(promptsDir, `codex-inline-response-${slug}-${inlineRequestId}.md`)
        : resolvedOutputFile;
      resolvedPromptFile = resolvedPromptFileLocal;
      resolvedOutputFile = resolvedOutputFileLocal;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return singleErrorBlock(`Failed to persist inline prompt (${reason}). Check working directory permissions and disk space.`);
    }
  }

  // Validate that at least one prompt source is provided.
  // Use type-guarded promptFileInput to avoid .trim() TypeError on non-string values.
  const effectivePromptFile = resolvedPromptFile;
  if (!effectivePromptFile || !effectivePromptFile.trim()) {
    return singleErrorBlock("Either 'prompt' (inline) or 'prompt_file' (file path) is required.");
  }

  // output_file is required in file mode.
  // Use typeof guard to avoid .trim() TypeError on non-string values.
  const effectiveOutputFile = resolvedOutputFile;
  if (!effectiveOutputFile || !effectiveOutputFile.trim()) {
    return singleErrorBlock('output_file is required. Specify a path where the response should be written.');
  }

  // Resolve prompt from prompt_file (validated non-empty above)
  let resolvedPrompt: string;
  const promptFile = effectivePromptFile;
  const resolvedPath = resolve(baseDir, promptFile);
  const cwdReal = realpathSync(baseDir);
  const relPath = relative(cwdReal, resolvedPath);
  if (!isExternalPromptAllowed() && (relPath === '..' || relPath.startsWith('..' + sep) || isAbsolute(relPath))) {
    const errorToken = 'E_PATH_OUTSIDE_WORKDIR_PROMPT';
    return singleErrorBlock(`${errorToken}: prompt_file '${promptFile}' resolves outside working_directory '${baseDirReal}'.
Requested: ${promptFile}
Working directory: ${baseDirReal}
Resolved working directory: ${baseDirReal}
Path policy: ${pathPolicy}
Suggested: place the prompt file within the working directory or set working_directory to a common ancestor`);
  }
  // BEFORE reading, resolve symlinks and validate boundary
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolvedPath);
  } catch (err) {
    const errorToken = 'E_PATH_RESOLUTION_FAILED';
    return singleErrorBlock(`${errorToken}: Failed to resolve prompt_file '${promptFile}'.
Error: ${(err as Error).message}
Resolved working directory: ${baseDirReal}
Path policy: ${pathPolicy}
Suggested: ensure the prompt file exists and is accessible`);
  }
  const relReal = relative(cwdReal, resolvedReal);
  if (!isExternalPromptAllowed() && (relReal === '..' || relReal.startsWith('..' + sep) || isAbsolute(relReal))) {
    const errorToken = 'E_PATH_OUTSIDE_WORKDIR_PROMPT';
    return singleErrorBlock(`${errorToken}: prompt_file '${promptFile}' resolves to a path outside working_directory '${baseDirReal}'.
Requested: ${promptFile}
Resolved path: ${resolvedReal}
Working directory: ${baseDirReal}
Resolved working directory: ${baseDirReal}
Path policy: ${pathPolicy}
Suggested: place the prompt file within the working directory or set working_directory to a common ancestor`);
  }
  // Now safe to read from the validated real path
  try {
    resolvedPrompt = readFileSync(resolvedReal, 'utf-8');
  } catch (err) {
    return singleErrorBlock(`Failed to read prompt_file '${promptFile}': ${(err as Error).message}`);
  }
  // Check for empty prompt
  if (!resolvedPrompt.trim()) {
    return singleErrorBlock(`prompt_file '${promptFile}' is empty.`);
  }

  // Add headless execution context so Codex produces comprehensive output
  const userPrompt = `[HEADLESS SESSION] You are running non-interactively in a headless pipeline. Produce your FULL, comprehensive analysis directly in your response. Do NOT ask for clarification or confirmation - work thoroughly with all provided context. Do NOT write brief acknowledgments - your response IS the deliverable.

${resolvedPrompt}`;

  // Check CLI availability
  const detection = detectCodexCli();
  if (!detection.available) {
    return singleErrorBlock(`Codex CLI is not available: ${detection.error}\n\n${detection.installHint}`);
  }

  // Resolve system prompt from agent role
  const resolvedSystemPrompt = resolveSystemPrompt(undefined, agent_role, 'codex');

  // Build file context
  let fileContext: string | undefined;
  if (context_files && context_files.length > 0) {
    fileContext = context_files.map(f => validateAndReadFile(f, baseDir)).join('\n\n');
  }

  // Combine: system prompt > file context > user prompt
  const fullPrompt = buildPromptWithSystemContext(userPrompt, fileContext, resolvedSystemPrompt);

  // Persist prompt for audit trail
  const promptResult = persistPrompt({
    provider: 'codex',
    agentRole: agent_role,
    model,
    files: context_files,
    prompt: resolvedPrompt,
    fullPrompt,
    workingDirectory: baseDir,
  });

  // Compute expected response path for immediate return
  const expectedResponsePath = promptResult
    ? getExpectedResponsePath('codex', promptResult.slug, promptResult.id, baseDir)
    : undefined;

  // Background mode: return immediately with job metadata
  if (args.background) {
    if (!promptResult) {
      return singleErrorBlock('Failed to persist prompt for background execution');
    }

    const statusFilePath = getStatusFilePath('codex', promptResult.slug, promptResult.id, baseDir);
    const result = executeCodexBackground(fullPrompt, args.model as string | undefined, {
      provider: 'codex',
      jobId: promptResult.id,
      slug: promptResult.slug,
      agentRole: agent_role,
      model: model, // This is the effective model for metadata
      promptFile: promptResult.filePath,
      responseFile: expectedResponsePath!,
    }, baseDir, resolvedEffort);

    if ('error' in result) {
      return singleErrorBlock(`Failed to spawn background job: ${result.error}`);
    }

    return {
      content: [{
        type: 'text' as const,
        text: [
          `**Mode:** Background (non-blocking)`,
          `**Job ID:** ${promptResult.id}`,
          `**Agent Role:** ${agent_role}`,
          `**Model:** ${model}`,
          `**PID:** ${result.pid}`,
          `**Prompt File:** ${promptResult.filePath}`,
          `**Response File:** ${expectedResponsePath}`,
          `**Status File:** ${statusFilePath}`,
          ``,
          `Job dispatched. Check response file existence or read status file for completion.`,
        ].join('\n')
      }]
    };
  }

  // Build parameter visibility block
  const paramLines = [
    `**Agent Role:** ${agent_role}`,
    resolvedEffort ? `**Reasoning Effort:** ${resolvedEffort}` : null,
    context_files?.length ? `**Files:** ${context_files.join(', ')}` : null,
    promptResult ? `**Prompt File:** ${promptResult.filePath}` : null,
    expectedResponsePath ? `**Response File:** ${expectedResponsePath}` : null,
    `**Resolved Working Directory:** ${baseDirReal}`,
    `**Path Policy:** ${pathPolicy}`,
  ].filter(Boolean).join('\n');

  try {
    const { response, usedFallback, actualModel } = await executeCodexWithFallback(fullPrompt, args.model as string | undefined, baseDir, fallbackChain, undefined, resolvedEffort);

    // Persist response to disk (audit trail)
    if (promptResult) {
      persistResponse({
        provider: 'codex',
        agentRole: agent_role,
        model: actualModel,
        promptId: promptResult.id,
        slug: promptResult.slug,
        response,
        workingDirectory: baseDir,
        usedFallback,
        fallbackModel: usedFallback ? actualModel : undefined,
      });
    }

    // Always write parsed JSONL response to output_file.
    // We no longer use -o (--output-last-message) because it only captures the
    // last agent message, which may be a brief acknowledgment. The JSONL-parsed
    // stdout contains ALL agent messages and is always more comprehensive.
    if (effectiveOutputFile) {
      const writeResult = safeWriteOutputFile(effectiveOutputFile, response, baseDirReal, '[codex-core]');
      if (!writeResult.success) {
        return singleErrorBlock(`${paramLines}\n\n---\n\n${writeResult.errorMessage}\n\nresolved_working_directory: ${baseDirReal}\npath_policy: ${pathPolicy}`);
      }
    }

    const responseLines = [paramLines];
    const fallbackLine = usedFallback ? `Fallback: used model ${actualModel}` : undefined;
    if (fallbackLine) {
      responseLines.push(fallbackLine);
    }

    // In inline mode, return metadata + raw response as separate content blocks
    if (isInlineMode) {
      responseLines.push(`**Request ID:** ${inlineRequestId}`);
      const metadataText = responseLines.join('\n');
      const wrappedResponse = wrapUntrustedCliResponse(response, { source: 'inline-cli-response', tool: 'ask_codex' });
      return inlineSuccessBlocks(metadataText, wrappedResponse);
    }

    return {
      content: [{
        type: 'text' as const,
        text: responseLines.join('\n')
      }]
    };
  } catch (err) {
    return singleErrorBlock(`${paramLines}\n\n---\n\nCodex CLI error: ${(err as Error).message}`);
  }
}
