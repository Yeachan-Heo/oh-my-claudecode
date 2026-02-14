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

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve, relative, sep, isAbsolute, basename, join } from 'path';
import { createStdoutCollector, safeWriteOutputFile } from './shared-exec.js';
import { detectGeminiCli } from './cli-detection.js';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { isExternalPromptAllowed } from './mcp-config.js';
import { resolveSystemPrompt, buildPromptWithSystemContext, wrapUntrustedFileContent, wrapUntrustedCliResponse, isValidAgentRoleName, VALID_AGENT_ROLES, singleErrorBlock, inlineSuccessBlocks } from './prompt-injection.js';
import { persistPrompt, persistResponse, getExpectedResponsePath, getPromptsDir, generatePromptId, slugify } from './prompt-persistence.js';
import { writeJobStatus, getStatusFilePath, readJobStatus } from './prompt-persistence.js';
import type { JobStatus, BackgroundJobMeta } from './prompt-persistence.js';
import {
  resolveExternalModel,
  buildFallbackChain,
  GEMINI_MODEL_FALLBACKS,
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
export const GEMINI_DEFAULT_MODEL = process.env.OMC_GEMINI_DEFAULT_MODEL || 'gemini-3-pro-preview';
export const GEMINI_TIMEOUT = Math.min(Math.max(5000, parseInt(process.env.OMC_GEMINI_TIMEOUT || '3600000', 10) || 3600000), 3600000);

// Gemini is best for design review and implementation tasks (recommended, not enforced)
export const GEMINI_RECOMMENDED_ROLES = ['designer', 'writer', 'vision'] as const;

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
export const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10MB stdout cap

/**
 * Check if Gemini stderr indicates a rate-limit (429) or quota error
 * that should trigger a fallback to the next model in the chain.
 *
 * IMPORTANT: Only checks stderr. Gemini CLI outputs plain text to stdout,
 * so stdout contains response content that may legitimately mention
 * "429", "rate limit", etc. Searching stdout causes false positives.
 */
export function isGeminiRetryableError(stdout: string, stderr: string = ''): { isError: boolean; message: string; type: 'rate_limit' | 'model' | 'none' } {
  // Only check stderr — stdout is response content (plain text) and must never
  // be searched for error patterns, as it causes false positives when the
  // response discusses rate limiting, HTTP 429, quotas, etc.

  // Check stderr for model not found / not supported
  if (/model.?not.?found|model is not supported|model.+does not exist|not.+available/i.test(stderr)) {
    const match = stderr.match(/.*(?:model.?not.?found|model is not supported|model.+does not exist|not.+available).*/i);
    return { isError: true, message: match?.[0]?.trim() || 'Model not available', type: 'model' };
  }
  // Check stderr for 429/rate limit errors
  if (/429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(stderr)) {
    const match = stderr.match(/.*(?:429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted).*/i);
    return { isError: true, message: match?.[0]?.trim() || 'Rate limit error detected', type: 'rate_limit' };
  }
  return { isError: false, message: '', type: 'none' };
}

/**
 * Execute Gemini CLI command and return the response
 */
export function executeGemini(prompt: string, model?: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (model) validateModelName(model);
    let settled = false;
    const args = ['-p=.', '--yolo'];
    if (model) {
      args.push('--model', model);
    }
    const child = spawn('gemini', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      // shell: true needed on Windows for .cmd/.bat executables.
      // Safe: args are array-based and model names are regex-validated.
      ...(process.platform === 'win32' ? { shell: true } : {})
    });

    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Gemini timed out after ${GEMINI_TIMEOUT}ms`));
      }
    }, GEMINI_TIMEOUT);

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
          // Only check for retryable errors when exit code is non-zero.
          // When code === 0, Gemini CLI mirrors response text to stderr,
          // which causes false positives if searched for error patterns
          // (e.g. a response discussing "429 rate limit" errors).
          if (code !== 0) {
            const retryable = isGeminiRetryableError('', stderr);
            if (retryable.isError) {
              reject(new Error(`Gemini ${retryable.type === 'rate_limit' ? 'rate limit' : 'model'} error: ${retryable.message}`));
              return;
            }
          }
          resolve(stdout.trim());
        } else {
          // No stdout, non-zero exit: check stderr for retryable errors
          const retryableExit = isGeminiRetryableError('', stderr);
          if (retryableExit.isError) {
            reject(new Error(`Gemini ${retryableExit.type === 'rate_limit' ? 'rate limit' : 'model'} error: ${retryableExit.message}`));
          } else {
            reject(new Error(`Gemini exited with code ${code}: ${stderr || 'No output'}`));
          }
        }
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        child.kill('SIGTERM');
        reject(new Error(`Failed to spawn Gemini CLI: ${err.message}`));
      }
    });

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
 * Execute Gemini CLI in background with fallback chain support
 * Retries with next model on model errors and 429/rate-limit errors
 */
export function executeGeminiBackground(
  fullPrompt: string,
  modelInput: string | undefined,
  jobMeta: BackgroundJobMeta,
  workingDirectory?: string
): { pid: number } | { error: string } {
  try {
    const modelExplicit = modelInput !== undefined && modelInput !== null && modelInput !== '';
    const effectiveModel = modelInput || GEMINI_DEFAULT_MODEL;

    // Build fallback chain
    const modelsToTry = modelExplicit
      ? [effectiveModel] // No fallback if model explicitly provided
      : (GEMINI_MODEL_FALLBACKS.includes(effectiveModel)
          ? GEMINI_MODEL_FALLBACKS.slice(GEMINI_MODEL_FALLBACKS.indexOf(effectiveModel))
          : [effectiveModel, ...GEMINI_MODEL_FALLBACKS]);

    // Helper to try spawning with a specific model
    const trySpawnWithModel = (tryModel: string, remainingModels: string[]): { pid: number } | { error: string } => {
      validateModelName(tryModel);
      const args = ['-p=.', '--yolo', '--model', tryModel];
      const child = spawn('gemini', args, {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(workingDirectory ? { cwd: workingDirectory } : {}),
        ...(process.platform === 'win32' ? { shell: true } : {})
      });

      if (!child.pid) {
        return { error: 'Failed to get process ID' };
      }

      const pid = child.pid;
      spawnedPids.add(pid);
      child.unref();

      const initialStatus: JobStatus = {
        provider: 'gemini',
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
            if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
            else child.kill('SIGTERM');
          } catch {
            // ignore
          }
          writeJobStatus({
            ...initialStatus,
            status: 'timeout',
            completedAt: new Date().toISOString(),
            error: `Gemini timed out after ${GEMINI_TIMEOUT}ms`,
          }, workingDirectory);
        }
      }, GEMINI_TIMEOUT);

      child.stdout?.on('data', (data: Buffer) => {
        collector.append(data.toString());
      });
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

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

        // Check if user killed this job
        const currentStatus = readJobStatus('gemini', jobMeta.slug, jobMeta.jobId, workingDirectory);
        if (currentStatus?.killedByUser) {
          return;
        }

        if (code === 0 || stdout.trim()) {
          // Only check for retryable errors when exit code is non-zero.
          // When code === 0, Gemini CLI mirrors response text to stderr,
          // which causes false positives if searched for error patterns.
          if (code !== 0) {
            const retryableErr = isGeminiRetryableError('', stderr);
            if (retryableErr.isError && remainingModels.length > 0) {
              const nextModel = remainingModels[0];
              const newRemainingModels = remainingModels.slice(1);
              const retryResult = trySpawnWithModel(nextModel, newRemainingModels);
              if ('error' in retryResult) {
                writeJobStatus({
                  ...initialStatus,
                  status: 'failed',
                  completedAt: new Date().toISOString(),
                  error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
                }, workingDirectory);
              }
              return;
            }
            if (retryableErr.isError) {
              writeJobStatus({
                ...initialStatus,
                status: 'failed',
                completedAt: new Date().toISOString(),
                error: `All models in fallback chain failed. Last error (${retryableErr.type}): ${retryableErr.message}`,
              }, workingDirectory);
              return;
            }
          }

          const response = stdout.trim();
          const usedFallback = tryModel !== effectiveModel;
          persistResponse({
            provider: 'gemini',
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
          // No stdout, non-zero exit: check stderr for retryable errors
          const retryableExit = isGeminiRetryableError('', stderr);
          if (retryableExit.isError && remainingModels.length > 0) {
            const nextModel = remainingModels[0];
            const newRemainingModels = remainingModels.slice(1);
            const retryResult = trySpawnWithModel(nextModel, newRemainingModels);
            if ('error' in retryResult) {
              writeJobStatus({
                ...initialStatus,
                status: 'failed',
                completedAt: new Date().toISOString(),
                error: `Fallback spawn failed for model ${nextModel}: ${retryResult.error}`,
              }, workingDirectory);
            }
            return;
          }
          writeJobStatus({
            ...initialStatus,
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: `Gemini exited with code ${code}: ${stderr || 'No output'}`,
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
          error: `Failed to spawn Gemini CLI: ${err.message}`,
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
    const resolvedAbs = resolve(baseDir || process.cwd(), filePath);

    // Security: ensure file is within working directory (worktree boundary)
    const cwd = baseDir || process.cwd();
    const cwdReal = realpathSync(cwd);

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
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return singleErrorBlock('Invalid request: args must be an object.');
  }

  const { agent_role, files } = args;

  // Resolve model based on configuration and agent role
  const config = loadConfig();
  const resolved = resolveExternalModel(config.externalModels, {
    agentRole: agent_role,
    explicitProvider: 'gemini',
    explicitModel: args.model,  // user explicitly passed model
  });
  const resolvedModel = resolved.model || GEMINI_DEFAULT_MODEL;

  // Derive baseDir from working_directory if provided
  let baseDir = args.working_directory || process.cwd();
  let baseDirReal: string;

  // Path policy for error messages
  const pathPolicy = process.env.OMC_ALLOW_EXTERNAL_WORKDIR === '1' ? 'permissive' : 'strict';

  try {
    baseDirReal = realpathSync(baseDir);
    baseDir = baseDirReal;
  } catch (err) {
    return singleErrorBlock(`E_WORKDIR_INVALID: working_directory '${args.working_directory}' does not exist or is not accessible.\nError: ${(err as Error).message}\nResolved working directory: ${baseDir}\nPath policy: ${pathPolicy}\nSuggested: ensure the working directory exists and is accessible`);
  }

  // Security: validate working_directory is within worktree (unless bypass enabled)
  if (process.env.OMC_ALLOW_EXTERNAL_WORKDIR !== '1') {
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
          return singleErrorBlock(`E_WORKDIR_INVALID: working_directory '${args.working_directory}' is outside the project worktree (${worktreeRoot}).\nRequested: ${args.working_directory}\nResolved working directory: ${baseDirReal}\nWorktree root: ${worktreeRoot}\nPath policy: ${pathPolicy}\nSuggested: use a working_directory within the project worktree, or set OMC_ALLOW_EXTERNAL_WORKDIR=1 to bypass`);
        }
      }
    }
  }


  // Validate agent_role - must be non-empty and pass character validation
  if (typeof agent_role !== 'string' || !agent_role.trim()) {
    return singleErrorBlock('agent_role is required and must be a non-empty string.');
  }
  if (!isValidAgentRoleName(agent_role)) {
    return singleErrorBlock(`Invalid agent_role: "${agent_role}". Role names must contain only lowercase letters, numbers, and hyphens. Recommended for Gemini: ${GEMINI_RECOMMENDED_ROLES.join(', ')}`);
  }
  // Validate agent_role exists in discovered roles (allowlist enforcement)
  if (!VALID_AGENT_ROLES.includes(agent_role)) {
    return singleErrorBlock(`Unknown agent_role: "${agent_role}". Available roles: ${VALID_AGENT_ROLES.join(', ')}. Recommended for Gemini: ${GEMINI_RECOMMENDED_ROLES.join(', ')}`);
  }

  // Inline prompt support: when `prompt` is provided as a string, auto-persist
  // it to a file for audit trail and continue with normal prompt_file flow.
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

  if (isInlineMode) {
    inlineRequestId = generatePromptId();

    // Auto-persist inline prompt to file
    try {
      const promptsDir = getPromptsDir(baseDir);
      mkdirSync(promptsDir, { recursive: true });
      const slug = slugify(inlinePrompt as string);
      const inlinePromptPath = join(promptsDir, `gemini-inline-${slug}-${inlineRequestId}.md`);
      writeFileSync(inlinePromptPath, inlinePrompt as string, { encoding: 'utf-8', mode: 0o600 });
      const resolvedPromptFileLocal = inlinePromptPath;
      const resolvedOutputFileLocal = (!resolvedOutputFile || !resolvedOutputFile.trim())
        ? join(promptsDir, `gemini-inline-response-${slug}-${inlineRequestId}.md`)
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

  // Validate output_file is provided after prompt source validation.
  // Use resolved inline/file output path to avoid args mutation.
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
    return singleErrorBlock(`E_PATH_OUTSIDE_WORKDIR_PROMPT: prompt_file '${promptFile}' resolves outside working_directory '${baseDirReal}'.\nRequested: ${promptFile}\nWorking directory: ${baseDirReal}\nResolved working directory: ${baseDirReal}\nPath policy: ${pathPolicy}\nSuggested: place the prompt file within the working directory or set working_directory to a common ancestor`);
  }

  // Symlink-safe check: resolve and validate BEFORE reading
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolvedPath);
  } catch (err) {
    return singleErrorBlock(`Failed to resolve prompt_file '${promptFile}': ${(err as Error).message}`);
  }
  const relReal = relative(cwdReal, resolvedReal);
  if (!isExternalPromptAllowed() && (relReal === '..' || relReal.startsWith('..' + sep) || isAbsolute(relReal))) {
    return singleErrorBlock(`E_PATH_OUTSIDE_WORKDIR_PROMPT: prompt_file '${promptFile}' resolves to a path outside working_directory '${baseDirReal}'.\nRequested: ${promptFile}\nResolved path: ${resolvedReal}\nWorking directory: ${baseDirReal}\nResolved working directory: ${baseDirReal}\nPath policy: ${pathPolicy}\nSuggested: place the prompt file within the working directory or set working_directory to a common ancestor`);
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

  // Add headless execution context so Gemini produces comprehensive output
  const userPrompt = `[HEADLESS SESSION] You are running non-interactively in a headless pipeline. Produce your FULL, comprehensive analysis directly in your response. Do NOT ask for clarification or confirmation - work thoroughly with all provided context. Do NOT write brief acknowledgments - your response IS the deliverable.

${resolvedPrompt}`;

  // Check CLI availability
  const detection = detectGeminiCli();
  if (!detection.available) {
    return singleErrorBlock(`Gemini CLI is not available: ${detection.error}\n\n${detection.installHint}`);
  }

  // Resolve system prompt from agent role
  const resolvedSystemPrompt = resolveSystemPrompt(undefined, agent_role, 'gemini');

  // Build file context
  let fileContext: string | undefined;
  if (files && files.length > 0) {
    fileContext = files.map(f => validateAndReadFile(f, baseDir)).join('\n\n');
  }

  // Combine: system prompt > file context > user prompt
  const fullPrompt = buildPromptWithSystemContext(userPrompt, fileContext, resolvedSystemPrompt);

  // Persist prompt for audit trail (once, before fallback loop)
  const promptResult = persistPrompt({
    provider: 'gemini',
    agentRole: agent_role,
    model: resolvedModel,
    files,
    prompt: resolvedPrompt,
    fullPrompt,
    workingDirectory: baseDir,
  });

  // Compute expected response path for immediate return
  const expectedResponsePath = promptResult
    ? getExpectedResponsePath('gemini', promptResult.slug, promptResult.id, baseDir)
    : undefined;

  // Background mode: return immediately with job metadata
  if (args.background) {
    if (!promptResult) {
      return singleErrorBlock('Failed to persist prompt for background execution');
    }

    const statusFilePath = getStatusFilePath('gemini', promptResult.slug, promptResult.id, baseDir);

    // Build fallback chain for display (executeGeminiBackground builds its own internally)
    const fallbackChainBg = buildFallbackChain('gemini', resolvedModel, config.externalModels);

    const result = executeGeminiBackground(fullPrompt, args.model as string | undefined, {
      provider: 'gemini',
      jobId: promptResult.id,
      slug: promptResult.slug,
      agentRole: agent_role,
      model: resolvedModel,
      promptFile: promptResult.filePath,
      responseFile: expectedResponsePath!,
    }, baseDir);

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
          `**Model (attempting):** ${fallbackChainBg[0]}`,
          `**Fallback chain:** ${fallbackChainBg.join(' -> ')}`,
          `**PID:** ${result.pid}`,
          `**Prompt File:** ${promptResult.filePath}`,
          `**Response File:** ${expectedResponsePath}`,
          `**Status File:** ${statusFilePath}`,
          ``,
          `Job dispatched. Will automatically try fallback models on 429/rate-limit or model errors.`,
        ].join('\n')
      }]
    };
  }

  // Build parameter visibility block
  const paramLines = [
    `**Agent Role:** ${agent_role}`,
    files?.length ? `**Files:** ${files.join(', ')}` : null,
    promptResult ? `**Prompt File:** ${promptResult.filePath}` : null,
    expectedResponsePath ? `**Response File:** ${expectedResponsePath}` : null,
    `**Resolved Working Directory:** ${baseDirReal}`,
    `**Path Policy:** ${pathPolicy}`,
  ].filter(Boolean).join('\n');

  // Build fallback chain using the resolver
  const fallbackChain = buildFallbackChain('gemini', resolvedModel, config.externalModels);

  let resolvedOutputPath: string | undefined;
  if (effectiveOutputFile) {
    resolvedOutputPath = resolve(baseDirReal, effectiveOutputFile);
  }

  const errors: string[] = [];
  for (const tryModel of fallbackChain) {
    try {
      const response = await executeGemini(fullPrompt, tryModel, baseDir);
      const usedFallback = tryModel !== resolvedModel;
      const fallbackLine = usedFallback ? `Fallback: used model ${tryModel}` : undefined;

      // Persist response to disk (audit trail)
      if (promptResult) {
        persistResponse({
          provider: 'gemini',
          agentRole: agent_role,
          model: tryModel,
          promptId: promptResult.id,
          slug: promptResult.slug,
          response,
          usedFallback,
          fallbackModel: usedFallback ? tryModel : undefined,
          workingDirectory: baseDir,
        });
      }

      // Always write response to output_file.
      if (effectiveOutputFile && resolvedOutputPath) {
        const writeResult = safeWriteOutputFile(effectiveOutputFile, response, baseDirReal, '[gemini-core]');
        if (!writeResult.success) {
          return singleErrorBlock(`${paramLines}\n\n---\n\n${writeResult.errorMessage}\n\nresolved_working_directory: ${baseDirReal}\npath_policy: ${pathPolicy}`);
        }
      }

      // Build success response metadata (match Codex inline assembly pattern)
      const responseLines = [paramLines];
      if (fallbackLine) {
        responseLines.push(fallbackLine);
      }

      // In inline mode, return metadata + raw response as separate content blocks
      if (isInlineMode) {
        responseLines.push(`**Request ID:** ${inlineRequestId}`);
        const metadataText = responseLines.join('\n');
        const wrappedResponse = wrapUntrustedCliResponse(response, { source: 'inline-cli-response', tool: 'ask_gemini' });
        return inlineSuccessBlocks(metadataText, wrappedResponse);
      }

      return {
        content: [{
          type: 'text' as const,
          text: responseLines.join('\n')
        }]
      };
    } catch (err) {
      const errMsg = (err as Error).message;
      errors.push(`${tryModel}: ${errMsg}`);
      // Only retry on retryable errors (model not found, 429/rate limit)
      if (!/model error|model.?not.?found|model is not supported|429|rate.?limit|too many requests|quota.?exceeded|resource.?exhausted/i.test(errMsg)) {
        // Non-retryable error — stop immediately
        return singleErrorBlock(`${paramLines}\n\n---\n\nGemini CLI error: ${errMsg}`);
      }
      // Continue to next model in chain
    }
  }

  return singleErrorBlock(`${paramLines}\n\n---\n\nGemini CLI error: all models in fallback chain failed.\n${errors.join('\n')}`);
}
