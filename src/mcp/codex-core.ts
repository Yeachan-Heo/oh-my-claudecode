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
import { dirname, resolve, relative, sep } from 'path';
import { detectCodexCli } from './cli-detection.js';
import { resolveSystemPrompt, buildPromptWithSystemContext } from './prompt-injection.js';
import { persistPrompt, persistResponse, getExpectedResponsePath } from './prompt-persistence.js';
import { writeJobStatus, getStatusFilePath } from './prompt-persistence.js';
import type { JobStatus, BackgroundJobMeta } from './prompt-persistence.js';

// Default model can be overridden via environment variable
export const CODEX_DEFAULT_MODEL = process.env.OMC_CODEX_DEFAULT_MODEL || 'gpt-5.2';
export const CODEX_TIMEOUT = Math.min(Math.max(5000, parseInt(process.env.OMC_CODEX_TIMEOUT || '3600000', 10) || 3600000), 3600000);

// Codex is best for analytical/planning tasks
export const CODEX_VALID_ROLES = ['architect', 'planner', 'critic', 'analyst', 'code-reviewer', 'security-reviewer', 'tdd-guide'] as const;

export const MAX_CONTEXT_FILES = 20;
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file

/**
 * Parse Codex JSONL output to extract the final text response
 */
export function parseCodexOutput(output: string): string {
  const lines = output.trim().split('\n').filter(l => l.trim());
  const messages: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // Look for message events with text content
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
      // Also handle output_text events
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
export function executeCodex(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const args = ['exec', '-m', model, '--json', '--full-auto'];
    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Manual timeout handling to ensure proper cleanup
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`Codex timed out after ${CODEX_TIMEOUT}ms`));
      }
    }, CODEX_TIMEOUT);

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
          resolve(parseCodexOutput(stdout));
        } else {
          reject(new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`));
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
 * Execute Codex CLI in background, writing status and response files upon completion
 */
export function executeCodexBackground(
  fullPrompt: string,
  model: string,
  jobMeta: BackgroundJobMeta
): { pid: number } | { error: string } {
  try {
    const args = ['exec', '-m', model, '--json', '--full-auto'];
    const child = spawn('codex', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (!child.pid) {
      return { error: 'Failed to get process ID' };
    }

    const pid = child.pid;
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
      model,
      agentRole: jobMeta.agentRole,
      spawnedAt: new Date().toISOString(),
    };
    writeJobStatus(initialStatus);

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
          error: `Codex timed out after ${CODEX_TIMEOUT}ms`,
        });
      }
    }, CODEX_TIMEOUT);

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
      });
    });
    child.stdin?.write(fullPrompt);
    child.stdin?.end();
    writeJobStatus({ ...initialStatus, status: 'running' });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);

      if (code === 0 || stdout.trim()) {
        const response = parseCodexOutput(stdout);
        persistResponse({
          provider: 'codex',
          agentRole: jobMeta.agentRole,
          model,
          promptId: jobMeta.jobId,
          slug: jobMeta.slug,
          response,
        });
        writeJobStatus({
          ...initialStatus,
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
      } else {
        writeJobStatus({
          ...initialStatus,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: `Codex exited with code ${code}: ${stderr || 'No output'}`,
        });
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
      });
    });

    return { pid };
  } catch (err) {
    return { error: `Failed to start background execution: ${(err as Error).message}` };
  }
}

/**
 * Validate and read a file for context inclusion
 */
export function validateAndReadFile(filePath: string): string {
  if (typeof filePath !== 'string') {
    return `--- File: ${filePath} --- (Invalid path type)`;
  }
  try {
    const resolvedAbs = resolve(filePath);

    // Security: ensure file is within working directory (worktree boundary)
    const cwd = process.cwd();
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
  context_files?: string[];
  background?: boolean;
}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { agent_role, model = CODEX_DEFAULT_MODEL, context_files } = args;

  // Validate agent_role
  if (!agent_role || !(CODEX_VALID_ROLES as readonly string[]).includes(agent_role)) {
    return {
      content: [{
        type: 'text' as const,
        text: `Invalid agent_role: "${agent_role}". Codex requires one of: ${CODEX_VALID_ROLES.join(', ')}`
      }],
      isError: true
    };
  }

  // Validate mutual exclusion of prompt and prompt_file
  if (args.prompt && args.prompt_file) {
    return {
      content: [{ type: 'text' as const, text: 'Cannot specify both prompt and prompt_file. Use one or the other.' }],
      isError: true
    };
  }

  // Resolve prompt from prompt_file or inline prompt
  let resolvedPrompt: string;
  if (args.prompt_file) {
    const resolvedPath = resolve(args.prompt_file);
    const cwd = process.cwd();
    const cwdReal = realpathSync(cwd);
    const relPath = relative(cwdReal, resolvedPath);
    if (relPath === '' || relPath === '..' || relPath.startsWith('..' + sep)) {
      return {
        content: [{ type: 'text' as const, text: `prompt_file '${args.prompt_file}' is outside the working directory.` }],
        isError: true
      };
    }
    try {
      resolvedPrompt = readFileSync(resolvedPath, 'utf-8');
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to read prompt_file '${args.prompt_file}': ${(err as Error).message}` }],
        isError: true
      };
    }
    // Symlink-safe check: ensure the real path also stays inside the boundary
    try {
      const resolvedReal = realpathSync(resolvedPath);
      const relReal = relative(cwdReal, resolvedReal);
      if (relReal === '' || relReal === '..' || relReal.startsWith('..' + sep)) {
        return {
          content: [{ type: 'text' as const, text: `prompt_file '${args.prompt_file}' resolves to a path outside the working directory.` }],
          isError: true
        };
      }
    } catch {
      // If realpathSync fails, the file was already read successfully, so continue
    }
    // Check for empty prompt
    if (!resolvedPrompt.trim()) {
      return {
        content: [{ type: 'text' as const, text: `prompt_file '${args.prompt_file}' is empty.` }],
        isError: true
      };
    }
  } else if (args.prompt) {
    resolvedPrompt = args.prompt;
  } else {
    return {
      content: [{ type: 'text' as const, text: 'Either prompt or prompt_file is required.' }],
      isError: true
    };
  }

  // If output_file specified, nudge the prompt to write there
  let userPrompt = resolvedPrompt;
  if (args.output_file) {
    const outputPath = resolve(args.output_file);
    userPrompt = `IMPORTANT: Write your complete response to the file: ${outputPath}\n\n${resolvedPrompt}`;
  }

  // Check CLI availability
  const detection = detectCodexCli();
  if (!detection.available) {
    return {
      content: [{
        type: 'text' as const,
        text: `Codex CLI is not available: ${detection.error}\n\n${detection.installHint}`
      }],
      isError: true
    };
  }

  // Resolve system prompt from agent role
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
    fileContext = context_files.map(f => validateAndReadFile(f)).join('\n\n');
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
  });

  // Compute expected response path for immediate return
  const expectedResponsePath = promptResult
    ? getExpectedResponsePath('codex', promptResult.slug, promptResult.id)
    : undefined;

  // Background mode: return immediately with job metadata
  if (args.background) {
    if (!promptResult) {
      return {
        content: [{ type: 'text' as const, text: 'Failed to persist prompt for background execution' }],
        isError: true
      };
    }

    const statusFilePath = getStatusFilePath('codex', promptResult.slug, promptResult.id);
    const result = executeCodexBackground(fullPrompt, model, {
      provider: 'codex',
      jobId: promptResult.id,
      slug: promptResult.slug,
      agentRole: agent_role,
      model,
      promptFile: promptResult.filePath,
      responseFile: expectedResponsePath!,
    });

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

  try {
    const response = await executeCodex(fullPrompt, model);

    // Persist response to disk
    if (promptResult) {
      persistResponse({
        provider: 'codex',
        agentRole: agent_role,
        model,
        promptId: promptResult.id,
        slug: promptResult.slug,
        response,
      });
    }

    // Handle output_file: if CLI didn't write it, write stdout there directly
    if (args.output_file) {
      const outputPath = resolve(args.output_file);

      // Security: validate output_file is within working directory
      const cwd = process.cwd();
      const cwdReal = realpathSync(cwd);
      const relOutput = relative(cwdReal, outputPath);
      if (relOutput === '' || relOutput === '..' || relOutput.startsWith('..' + sep)) {
        console.warn(`[codex-core] output_file '${args.output_file}' is outside the working directory, skipping write.`);
      } else {
        try {
          if (!existsSync(outputPath)) {
            const outDir = dirname(outputPath);
            const relOutDir = relative(cwdReal, outDir);
            if (!(relOutDir === '' || relOutDir === '..' || relOutDir.startsWith('..' + sep))) {
              mkdirSync(outDir, { recursive: true });
              writeFileSync(outputPath, response, 'utf-8');
            }
          }
        } catch (err) {
          console.warn(`[codex-core] Failed to write output file: ${(err as Error).message}`);
        }
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: `${paramLines}\n\n---\n\n${response}`
      }]
    };
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: `${paramLines}\n\n---\n\nCodex CLI error: ${(err as Error).message}`
      }],
      isError: true
    };
  }
}
