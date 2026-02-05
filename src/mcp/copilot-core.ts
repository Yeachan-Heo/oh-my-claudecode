/**
 * Copilot MCP Core - Shared business logic for GitHub Copilot CLI integration
 *
 * This module contains all the business logic for the Copilot MCP integration.
 * It is imported by the in-process SDK server (copilot-server.ts).
 *
 * This module is SDK-agnostic and contains no dependencies on @anthropic-ai/claude-agent-sdk.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve, relative, sep, isAbsolute, basename, join } from 'path';
import { getWorktreeRoot } from '../lib/worktree-paths.js';
import { detectCopilotCli } from './cli-detection.js';
import { resolveSystemPrompt, buildPromptWithSystemContext } from './prompt-injection.js';
import { persistPrompt, persistResponse, getExpectedResponsePath } from './prompt-persistence.js';
import { writeJobStatus, getStatusFilePath, readJobStatus } from './prompt-persistence.js';
import type { JobStatus, BackgroundJobMeta } from './prompt-persistence.js';

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
export const COPILOT_DEFAULT_MODEL = process.env.OMC_COPILOT_DEFAULT_MODEL || 'gpt-5.1-codex-max';
export const COPILOT_TIMEOUT = Math.min(Math.max(5000, parseInt(process.env.OMC_COPILOT_TIMEOUT || '3600000', 10) || 3600000), 3600000);

// Copilot is a full coding agent, suitable for analytical/planning tasks like Codex
export const COPILOT_VALID_ROLES = ['architect', 'planner', 'critic', 'analyst', 'code-reviewer', 'security-reviewer', 'tdd-guide'] as const;

export const MAX_CONTEXT_FILES = 20;
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file

/**
 * Execute Copilot CLI command and return the response.
 * Copilot CLI reads from stdin and outputs plain text.
 */
export function executeCopilot(prompt: string, model: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    validateModelName(model);
    let settled = false;
    const args = ['--allow-all-tools', '--allow-all-paths', '--model', model];
    const child = spawn('copilot', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {})
    });

    // Manual timeout handling to ensure proper cleanup
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Copilot timed out after ${COPILOT_TIMEOUT}ms`));
      }
    }, COPILOT_TIMEOUT);

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
          reject(new Error(`Copilot exited with code ${code}: ${stderr || 'No output'}`));
        }
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        child.kill('SIGTERM');
        reject(new Error(`Failed to spawn Copilot CLI: ${err.message}`));
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
 * Execute Copilot CLI in background, writing status and response files upon completion
 */
export function executeCopilotBackground(
  fullPrompt: string,
  model: string,
  jobMeta: BackgroundJobMeta,
  workingDirectory?: string
): { pid: number } | { error: string } {
  try {
    validateModelName(model);
    const args = ['--allow-all-tools', '--allow-all-paths', '--model', model];
    const child = spawn('copilot', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(workingDirectory ? { cwd: workingDirectory } : {})
    });

    if (!child.pid) {
      return { error: 'Failed to get process ID' };
    }

    const pid = child.pid;
    spawnedPids.add(pid);
    child.unref();

    // Write initial spawned status
    const initialStatus: JobStatus = {
      provider: 'copilot',
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
          if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          // ignore
        }
        writeJobStatus({
          ...initialStatus,
          status: 'timeout',
          completedAt: new Date().toISOString(),
          error: `Copilot timed out after ${COPILOT_TIMEOUT}ms`,
        }, workingDirectory);
      }
    }, COPILOT_TIMEOUT);

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
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

      // Check if user killed this job
      const currentStatus = readJobStatus('copilot', jobMeta.slug, jobMeta.jobId, workingDirectory);
      if (currentStatus?.killedByUser) {
        return;
      }

      if (code === 0 || stdout.trim()) {
        const response = stdout.trim();
        persistResponse({
          provider: 'copilot',
          agentRole: jobMeta.agentRole,
          model,
          promptId: jobMeta.jobId,
          slug: jobMeta.slug,
          response,
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
          error: `Copilot exited with code ${code}: ${stderr || 'No output'}`,
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
        error: `Failed to spawn Copilot CLI: ${err.message}`,
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
    const workingDir = baseDir || process.cwd();
    const resolvedAbs = resolve(workingDir, filePath);
    const cwdReal = realpathSync(workingDir);
    const relAbs = relative(cwdReal, resolvedAbs);
    if (relAbs === '' || relAbs === '..' || relAbs.startsWith('..' + sep)) {
      return `[BLOCKED] File '${filePath}' is outside the working directory.`;
    }
    const resolvedReal = realpathSync(resolvedAbs);
    const relReal = relative(cwdReal, resolvedReal);
    if (relReal === '' || relReal === '..' || relReal.startsWith('..' + sep)) {
      return `[BLOCKED] File '${filePath}' is outside the working directory.`;
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
 * Handle ask_copilot tool invocation with all business logic
 */
export async function handleAskCopilot(args: {
  prompt_file: string;
  output_file: string;
  agent_role: string;
  model?: string;
  context_files?: string[];
  background?: boolean;
  working_directory?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { agent_role, model = COPILOT_DEFAULT_MODEL, context_files } = args;

  const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
  let trustedRootReal: string;
  try {
    trustedRootReal = realpathSync(trustedRoot);
  } catch {
    trustedRootReal = trustedRoot;
  }

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

  const relToRoot = relative(trustedRootReal, baseDirReal);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    return {
      content: [{ type: 'text' as const, text: `working_directory '${args.working_directory}' is outside the trusted worktree root '${trustedRoot}'.` }],
      isError: true
    };
  }

  if (!agent_role || !(COPILOT_VALID_ROLES as readonly string[]).includes(agent_role)) {
    return {
      content: [{
        type: 'text' as const,
        text: `Invalid agent_role: "${agent_role}". Copilot requires one of: ${COPILOT_VALID_ROLES.join(', ')}`
      }],
      isError: true
    };
  }

  if (!args.output_file || !args.output_file.trim()) {
    return {
      content: [{ type: 'text' as const, text: 'output_file is required.' }],
      isError: true
    };
  }

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
  try {
    resolvedPrompt = readFileSync(resolvedReal, 'utf-8');
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Failed to read prompt_file '${args.prompt_file}': ${(err as Error).message}` }],
      isError: true
    };
  }
  if (!resolvedPrompt.trim()) {
    return {
      content: [{ type: 'text' as const, text: `prompt_file '${args.prompt_file}' is empty.` }],
      isError: true
    };
  }

  // If output_file specified, nudge the CLI to write a work summary there
  let userPrompt = resolvedPrompt;
  if (args.output_file) {
    const outputPath = resolve(baseDir, args.output_file);
    userPrompt = `IMPORTANT: After completing the task, write a WORK SUMMARY to: ${outputPath}
Include: what was done, files modified/created, key decisions made, and any issues encountered.
The summary is for the orchestrator to understand what changed - actual work products should be created directly.

${resolvedPrompt}`;
  }

  // Check CLI availability
  const detection = detectCopilotCli();
  if (!detection.available) {
    return {
      content: [{
        type: 'text' as const,
        text: `Copilot CLI is not available: ${detection.error}\n\n${detection.installHint}`
      }],
      isError: true
    };
  }

  const resolvedSystemPrompt = resolveSystemPrompt(undefined, agent_role);

  // Build file context
  let fileContext: string | undefined;
  if (context_files && context_files.length > 0) {
    if (context_files.length > MAX_CONTEXT_FILES) {
      return {
        content: [{
          type: 'text' as const,
          text: `Too many context files (max ${MAX_CONTEXT_FILES}, got ${context_files.length})`
        }],
        isError: true
      };
    }
    fileContext = context_files.map(f => validateAndReadFile(f, baseDir)).join('\n\n');
  }

  const fullPrompt = buildPromptWithSystemContext(userPrompt, fileContext, resolvedSystemPrompt);

  // Persist prompt for audit trail
  const promptResult = persistPrompt({
    provider: 'copilot',
    agentRole: agent_role,
    model,
    files: context_files,
    prompt: resolvedPrompt,
    fullPrompt,
    workingDirectory: baseDir,
  });

  const expectedResponsePath = promptResult
    ? getExpectedResponsePath('copilot', promptResult.slug, promptResult.id, baseDir)
    : undefined;

  // Background mode
  if (args.background) {
    if (!promptResult) {
      return {
        content: [{ type: 'text' as const, text: 'Failed to persist prompt for background execution' }],
        isError: true
      };
    }

    const statusFilePath = getStatusFilePath('copilot', promptResult.slug, promptResult.id, baseDir);
    const result = executeCopilotBackground(fullPrompt, model, {
      provider: 'copilot',
      jobId: promptResult.id,
      slug: promptResult.slug,
      agentRole: agent_role,
      model,
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
    context_files?.length ? `**Files:** ${context_files.join(', ')}` : null,
    promptResult ? `**Prompt File:** ${promptResult.filePath}` : null,
    expectedResponsePath ? `**Response File:** ${expectedResponsePath}` : null,
  ].filter(Boolean).join('\n');

  // Record output_file mtime before execution
  let outputFileMtimeBefore: number | null = null;
  let resolvedOutputPath: string | undefined;
  if (args.output_file) {
    resolvedOutputPath = resolve(baseDirReal, args.output_file);
    try {
      outputFileMtimeBefore = statSync(resolvedOutputPath).mtimeMs;
    } catch {
      outputFileMtimeBefore = null;
    }
  }

  try {
    const response = await executeCopilot(fullPrompt, model, baseDir);

    if (promptResult) {
      persistResponse({
        provider: 'copilot',
        agentRole: agent_role,
        model,
        promptId: promptResult.id,
        slug: promptResult.slug,
        response,
        workingDirectory: baseDir,
      });
    }

    // Handle output_file: only write if CLI didn't already write to it
    if (args.output_file && resolvedOutputPath) {
      let cliWroteFile = false;
      try {
        const currentMtime = statSync(resolvedOutputPath).mtimeMs;
        cliWroteFile = outputFileMtimeBefore !== null
          ? currentMtime > outputFileMtimeBefore
          : true;
      } catch {
        cliWroteFile = false;
      }

      if (!cliWroteFile) {
        const outputPath = resolvedOutputPath;
        const relOutput = relative(trustedRootReal, outputPath);
        if (!(relOutput === '' || relOutput.startsWith('..') || isAbsolute(relOutput))) {
          try {
            const outputDir = dirname(outputPath);
            if (!existsSync(outputDir)) {
              const relDir = relative(trustedRootReal, outputDir);
              if (!(relDir.startsWith('..') || isAbsolute(relDir))) {
                mkdirSync(outputDir, { recursive: true });
              }
            }
            let outputDirReal: string | undefined;
            try {
              outputDirReal = realpathSync(outputDir);
            } catch {
              // skip
            }
            if (outputDirReal) {
              const relDirReal = relative(trustedRootReal, outputDirReal);
              if (!(relDirReal.startsWith('..') || isAbsolute(relDirReal))) {
                const safePath = join(outputDirReal, basename(outputPath));
                writeFileSync(safePath, response, 'utf-8');
              }
            }
          } catch (err) {
            console.warn(`[copilot-core] Failed to write output file: ${(err as Error).message}`);
          }
        }
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: paramLines
      }]
    };
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: `${paramLines}\n\n---\n\nCopilot CLI error: ${(err as Error).message}`
      }],
      isError: true
    };
  }
}
