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
import { dirname, resolve, relative, sep, isAbsolute } from 'path';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { detectGeminiCli } from './cli-detection.js';
import { resolveSystemPrompt, buildPromptWithSystemContext } from './prompt-injection.js';
import { persistPrompt, persistResponse, getExpectedResponsePath } from './prompt-persistence.js';
import { writeJobStatus, getStatusFilePath, readJobStatus } from './prompt-persistence.js';
import type { JobStatus, BackgroundJobMeta } from './prompt-persistence.js';

// Default model can be overridden via environment variable
export const GEMINI_DEFAULT_MODEL = process.env.OMC_GEMINI_DEFAULT_MODEL || 'gemini-3-pro-preview';
export const GEMINI_TIMEOUT = Math.min(Math.max(5000, parseInt(process.env.OMC_GEMINI_TIMEOUT || '3600000', 10) || 3600000), 3600000);

// Model fallback chain: try each in order if previous fails
export const GEMINI_MODEL_FALLBACKS = [
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

// Gemini is best for design review and implementation tasks (leverages 1M context)
export const GEMINI_VALID_ROLES = ['designer', 'writer', 'vision'] as const;

export const MAX_CONTEXT_FILES = 20;
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file

/**
 * Execute Gemini CLI command and return the response
 */
export function executeGemini(prompt: string, model?: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const args = ['--yolo'];
    if (model) {
      args.push('--model', model);
    }
    const child = spawn('gemini', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {})
    });

    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Gemini timed out after ${GEMINI_TIMEOUT}ms`));
      }
    }, GEMINI_TIMEOUT);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        if (code === 0 || stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Gemini exited with code ${code}: ${stderr || 'No output'}`));
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
 * Execute Gemini CLI in background (single model, no fallback chain)
 */
export function executeGeminiBackground(
  fullPrompt: string,
  model: string,
  jobMeta: BackgroundJobMeta,
  workingDirectory?: string
): { pid: number } | { error: string } {
  try {
    const args = ['--yolo'];
    if (model) {
      args.push('--model', model);
    }
    const child = spawn('gemini', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(workingDirectory ? { cwd: workingDirectory } : {})
    });

    if (!child.pid) {
      return { error: 'Failed to get process ID' };
    }

    const pid = child.pid;
    child.unref();

    const initialStatus: JobStatus = {
      provider: 'gemini',
      jobId: jobMeta.jobId,
      slug: jobMeta.slug,
      status: 'spawned',
      pid,
      promptFile: jobMeta.promptFile,
      responseFile: jobMeta.responseFile,
      model,
      agentRole: jobMeta.agentRole,
      spawnedAt: new Date().toISOString(),
    };
    writeJobStatus(initialStatus, workingDirectory);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
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
          error: `Gemini timed out after ${GEMINI_TIMEOUT}ms`,
        }, workingDirectory);
      }
    }, GEMINI_TIMEOUT);

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
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

      // Check if user killed this job - if so, don't overwrite the killed status
      const currentStatus = readJobStatus('gemini', jobMeta.slug, jobMeta.jobId);
      if (currentStatus?.killedByUser) {
        return; // Status already set by kill_job, don't overwrite
      }

      if (code === 0 || stdout.trim()) {
        persistResponse({
          provider: 'gemini',
          agentRole: jobMeta.agentRole,
          model,
          promptId: jobMeta.jobId,
          slug: jobMeta.slug,
          response: stdout.trim(),
          workingDirectory,
        });
        writeJobStatus({
          ...initialStatus,
          status: 'completed',
          completedAt: new Date().toISOString(),
        }, workingDirectory);
      } else {
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
    if (relAbs === '' || relAbs === '..' || relAbs.startsWith('..' + sep)) {
      return `[BLOCKED] File '${filePath}' is outside the working directory. Only files within the project are allowed.`;
    }

    // Symlink-safe check: ensure the real path also stays inside the boundary.
    const resolvedReal = realpathSync(resolvedAbs);
    const relReal = relative(cwdReal, resolvedReal);
    if (relReal === '' || relReal === '..' || relReal.startsWith('..' + sep)) {
      return `[BLOCKED] File '${filePath}' is outside the working directory. Only files within the project are allowed.`;
    }

    const stats = statSync(resolvedReal);
    if (!stats.isFile()) {
      return `--- File: ${filePath} --- (Not a regular file)`;
    }
    if (stats.size > MAX_FILE_SIZE) {
      return `--- File: ${filePath} --- (File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB, max 5MB)`;
    }
    return `--- File: ${filePath} ---\n${readFileSync(resolvedReal, 'utf-8')}`;
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
  prompt_file: string;
  output_file: string;
  agent_role: string;
  model?: string;
  files?: string[];
  background?: boolean;
  working_directory?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { agent_role, model = GEMINI_DEFAULT_MODEL, files } = args;

  // Derive trusted root from process.cwd(), NOT from user-controlled input
  const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
  let trustedRootReal: string;
  try {
    trustedRootReal = realpathSync(trustedRoot);
  } catch {
    trustedRootReal = trustedRoot; // Fallback if realpath fails
  }

  // Derive baseDir from working_directory if provided
  let baseDir = args.working_directory || process.cwd();
  let baseDirReal: string;
  try {
    baseDirReal = realpathSync(baseDir);
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `working_directory '${args.working_directory}' does not exist or is not accessible: ${(err as Error).message}` }],
      isError: true
    };
  }

  // Validate baseDir is within trusted root
  const relToRoot = relative(trustedRootReal, baseDirReal);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    return {
      content: [{ type: 'text' as const, text: `working_directory '${args.working_directory}' is outside the trusted worktree root '${trustedRoot}'.` }],
      isError: true
    };
  }

  // Validate agent_role
  if (!agent_role || !(GEMINI_VALID_ROLES as readonly string[]).includes(agent_role)) {
    return {
      content: [{
        type: 'text' as const,
        text: `Invalid agent_role: "${agent_role}". Gemini requires one of: ${GEMINI_VALID_ROLES.join(', ')}`
      }],
      isError: true
    };
  }

  // Validate output_file is provided
  if (!args.output_file || !args.output_file.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'output_file is required. Specify a path where the response should be written.' }],
      isError: true
    };
  }

  // Check if old 'prompt' parameter is used (hard error)
  if ('prompt' in (args as Record<string, unknown>)) {
    return {
      content: [{ type: 'text' as const, text: "The 'prompt' parameter has been removed. Write the prompt to a file (recommended: .omc/prompts/) and pass 'prompt_file' instead." }],
      isError: true
    };
  }

  // Validate prompt_file is provided
  if (!args.prompt_file || !args.prompt_file.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'prompt_file is required.' }],
      isError: true
    };
  }

  // Resolve prompt from prompt_file
  let resolvedPrompt: string;
  const resolvedPath = resolve(baseDir, args.prompt_file);
  const cwdReal = realpathSync(baseDir);
  const relPath = relative(cwdReal, resolvedPath);
  if (relPath === '' || relPath === '..' || relPath.startsWith('..' + sep)) {
    return {
      content: [{ type: 'text' as const, text: `prompt_file '${args.prompt_file}' is outside the working directory.` }],
      isError: true
    };
  }

  // Symlink-safe check: resolve and validate BEFORE reading
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolvedPath);
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Failed to resolve prompt_file '${args.prompt_file}': ${(err as Error).message}` }],
      isError: true
    };
  }
  const relReal = relative(cwdReal, resolvedReal);
  if (relReal === '' || relReal === '..' || relReal.startsWith('..' + sep)) {
    return {
      content: [{ type: 'text' as const, text: `prompt_file '${args.prompt_file}' resolves to a path outside the working directory.` }],
      isError: true
    };
  }

  // Now safe to read from the validated real path
  try {
    resolvedPrompt = readFileSync(resolvedReal, 'utf-8');
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Failed to read prompt_file '${args.prompt_file}': ${(err as Error).message}` }],
      isError: true
    };
  }
  // Check for empty prompt
  if (!resolvedPrompt.trim()) {
    return {
      content: [{ type: 'text' as const, text: `prompt_file '${args.prompt_file}' is empty.` }],
      isError: true
    };
  }

  // If output_file specified, nudge the prompt to write there
  let userPrompt = resolvedPrompt;
  if (args.output_file) {
    const outputPath = resolve(baseDir, args.output_file);
    userPrompt = `IMPORTANT: Write your complete response to the file: ${outputPath}\n\n${resolvedPrompt}`;
  }

  // Check CLI availability
  const detection = detectGeminiCli();
  if (!detection.available) {
    return {
      content: [{
        type: 'text' as const,
        text: `Gemini CLI is not available: ${detection.error}\n\n${detection.installHint}`
      }],
      isError: true
    };
  }

  // Resolve system prompt from agent role
  const resolvedSystemPrompt = resolveSystemPrompt(undefined, agent_role);

  // Build file context
  let fileContext: string | undefined;
  if (files && files.length > 0) {
    if (files.length > MAX_CONTEXT_FILES) {
      return {
        content: [{
          type: 'text' as const,
          text: `Too many context files (max ${MAX_CONTEXT_FILES}, got ${files.length})`
        }],
        isError: true
      };
    }
    fileContext = files.map(f => validateAndReadFile(f, baseDir)).join('\n\n');
  }

  // Combine: system prompt > file context > user prompt
  const fullPrompt = buildPromptWithSystemContext(userPrompt, fileContext, resolvedSystemPrompt);

  // Persist prompt for audit trail (once, before fallback loop)
  const promptResult = persistPrompt({
    provider: 'gemini',
    agentRole: agent_role,
    model,
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
      return {
        content: [{ type: 'text' as const, text: 'Failed to persist prompt for background execution' }],
        isError: true
      };
    }

    const statusFilePath = getStatusFilePath('gemini', promptResult.slug, promptResult.id, baseDir);
    const requestedModel = model;
    const fallbackIndex = GEMINI_MODEL_FALLBACKS.indexOf(requestedModel);
    const modelsToTry = fallbackIndex >= 0
      ? GEMINI_MODEL_FALLBACKS.slice(fallbackIndex)
      : [requestedModel, ...GEMINI_MODEL_FALLBACKS];

    const result = executeGeminiBackground(fullPrompt, modelsToTry[0], {
      provider: 'gemini',
      jobId: promptResult.id,
      slug: promptResult.slug,
      agentRole: agent_role,
      model: modelsToTry[0],
      promptFile: promptResult.filePath,
      responseFile: expectedResponsePath!,
    }, baseDir);

    if ('error' in result) {
      return {
        content: [{ type: 'text' as const, text: `Failed to spawn background job: ${result.error}` }],
        isError: true
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: [
          `**Mode:** Background (non-blocking)`,
          `**Job ID:** ${promptResult.id}`,
          `**Agent Role:** ${agent_role}`,
          `**Model (attempting):** ${modelsToTry[0]}`,
          `**Fallback chain:** ${modelsToTry.join(' -> ')}`,
          `**PID:** ${result.pid}`,
          `**Prompt File:** ${promptResult.filePath}`,
          `**Response File:** ${expectedResponsePath}`,
          `**Status File:** ${statusFilePath}`,
          ``,
          `Job dispatched. Background mode tries first model only.`,
          `If it fails, check status file and retry with next model.`,
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
  ].filter(Boolean).join('\n');

  // Build fallback chain: start from the requested model
  const requestedModel = model;
  const fallbackIndex = GEMINI_MODEL_FALLBACKS.indexOf(requestedModel);
  const modelsToTry = fallbackIndex >= 0
    ? GEMINI_MODEL_FALLBACKS.slice(fallbackIndex)
    : [requestedModel, ...GEMINI_MODEL_FALLBACKS];

  const errors: string[] = [];
  for (const tryModel of modelsToTry) {
    try {
      const response = await executeGemini(fullPrompt, tryModel, baseDir);
      const usedFallback = tryModel !== requestedModel;
      const fallbackNote = usedFallback ? `[Fallback: used ${tryModel} instead of ${requestedModel}]\n\n` : '';

      // Persist response to disk
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

      // Handle output_file: if CLI didn't write it, write stdout there directly
      if (args.output_file) {
        const outputPath = resolve(baseDirReal, args.output_file);

        // Lexical check: outputPath must be within trusted root
        const relOutput = relative(trustedRootReal, outputPath);
        if (relOutput === '' || relOutput.startsWith('..') || isAbsolute(relOutput)) {
          console.warn(`[gemini-core] output_file '${args.output_file}' resolves outside trusted root, skipping write.`);
        } else {
          try {
            const outputDir = dirname(outputPath);

            // Ensure parent directory exists within trusted root
            if (!existsSync(outputDir)) {
              const relDir = relative(trustedRootReal, outputDir);
              if (relDir.startsWith('..') || isAbsolute(relDir)) {
                console.warn(`[gemini-core] output_file directory is outside trusted root, skipping write.`);
              } else {
                mkdirSync(outputDir, { recursive: true });
              }
            }

            // Validate parent directory with realpath (symlink-safe for existing directories)
            let outputDirReal: string | undefined;
            try {
              outputDirReal = realpathSync(outputDir);
            } catch {
              // Parent still doesn't exist after mkdir - skip write
              console.warn(`[gemini-core] Failed to resolve output directory, skipping write.`);
            }

            if (outputDirReal) {
              const relDirReal = relative(trustedRootReal, outputDirReal);
              // relDirReal === '' means output dir IS the trusted root - this is ALLOWED
              // Only block if directory resolves OUTSIDE trusted root
              if (relDirReal.startsWith('..') || isAbsolute(relDirReal)) {
                console.warn(`[gemini-core] output_file directory resolves outside trusted root, skipping write.`);
              } else {
                // ALWAYS write (Issue 3 fix: no existence check)
                writeFileSync(outputPath, response, 'utf-8');
              }
            }
          } catch (err) {
            console.warn(`[gemini-core] Failed to write output file: ${(err as Error).message}`);
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `${fallbackNote}${paramLines}`
        }]
      };
    } catch (err) {
      errors.push(`${tryModel}: ${(err as Error).message}`);
    }
  }

  return {
    content: [{
      type: 'text' as const,
      text: `${paramLines}\n\n---\n\nGemini CLI error: all models failed.\n${errors.join('\n')}`
    }],
    isError: true
  };
}
