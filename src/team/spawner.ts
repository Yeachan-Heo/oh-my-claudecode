// src/team/spawner.ts

/**
 * Cross-CLI Spawner Interface and Implementations
 *
 * Formalizes the spawner pattern so the bridge can spawn different CLI backends
 * (Codex, Gemini, Claude Code) through a unified interface.
 */

import { spawn, ChildProcess, execSync } from 'child_process';

/** Configuration for a single spawn invocation */
export interface SpawnRunConfig {
  model: string;
  workingDirectory: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

/** Result of a spawn invocation */
export interface SpawnResult {
  output: string;
  exitCode: number;
  durationMs: number;
}

/** Handle returned by spawn — exposes child for kill and result promise */
export interface SpawnHandle {
  child: ChildProcess;
  result: Promise<SpawnResult>;
}

/**
 * Unified interface for spawning CLI backends.
 *
 * Each implementation encapsulates the command construction, input delivery,
 * and output parsing specific to a particular CLI tool.
 */
export interface WorkerSpawner {
  /** Spawn the CLI process with prompt, return handle with child and result promise */
  spawn(prompt: string, config: SpawnRunConfig): SpawnHandle;
  /** Check if the CLI binary is available on PATH */
  isAvailable(): boolean;
  /** Get the default model for this spawner */
  defaultModel(): string;
}

/** Maximum stdout/stderr buffer size (10MB) */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** Maximum accumulated size for Codex JSONL parsing (1MB) */
const MAX_CODEX_OUTPUT_SIZE = 1024 * 1024;

/** Check if a binary exists on PATH */
function isBinaryAvailable(name: string): boolean {
  try {
    const command = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(command, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared spawn logic: creates the child process, wires up stdout/stderr collection,
 * timeout handling, and stdin delivery. Returns a SpawnHandle.
 */
function spawnWithPipe(
  cmd: string,
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
  parseOutput: (stdout: string) => string,
  env?: Record<string, string>,
): SpawnHandle {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });

  const startTime = Date.now();

  const result = new Promise<SpawnResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`CLI timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < MAX_BUFFER_SIZE) stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (stderr.length < MAX_BUFFER_SIZE) stderr += data.toString();
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        const exitCode = code ?? 1;
        if (exitCode === 0) {
          resolve({
            output: parseOutput(stdout),
            exitCode,
            durationMs: Date.now() - startTime,
          });
        } else {
          const detail = stderr || stdout.trim() || 'No output';
          reject(new Error(`CLI exited with code ${exitCode}: ${detail}`));
        }
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to spawn ${cmd}: ${err.message}`));
      }
    });

    // Write prompt via stdin
    child.stdin?.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        child.kill('SIGTERM');
        reject(new Error(`Stdin write error: ${err.message}`));
      }
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });

  return { child, result };
}

/** Parse Codex JSONL output to extract text responses */
function parseCodexOutput(output: string): string {
  const lines = output.trim().split('\n').filter(l => l.trim());
  const messages: string[] = [];
  let totalSize = 0;

  for (const line of lines) {
    if (totalSize >= MAX_CODEX_OUTPUT_SIZE) {
      messages.push('[output truncated]');
      break;
    }
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        messages.push(event.item.text);
        totalSize += event.item.text.length;
      }
      if (event.type === 'message' && event.content) {
        if (typeof event.content === 'string') {
          messages.push(event.content);
          totalSize += event.content.length;
        } else if (Array.isArray(event.content)) {
          for (const part of event.content) {
            if (part.type === 'text' && part.text) {
              messages.push(part.text);
              totalSize += part.text.length;
            }
          }
        }
      }
      if (event.type === 'output_text' && event.text) {
        messages.push(event.text);
        totalSize += event.text.length;
      }
    } catch { /* skip non-JSON lines */ }
  }

  return messages.join('\n') || output;
}

/**
 * CodexSpawner — Spawns the OpenAI Codex CLI.
 *
 * Command: `codex exec -m {model} --json --full-auto`
 * Input: prompt via stdin
 * Output: JSONL events parsed to extract text
 */
export class CodexSpawner implements WorkerSpawner {
  spawn(prompt: string, config: SpawnRunConfig): SpawnHandle {
    const args = ['exec', '-m', config.model || this.defaultModel(), '--json', '--full-auto'];
    return spawnWithPipe('codex', args, prompt, config.workingDirectory, config.timeoutMs, parseCodexOutput, config.env);
  }

  isAvailable(): boolean {
    return isBinaryAvailable('codex');
  }

  defaultModel(): string {
    return 'gpt-5.3-codex';
  }
}

/**
 * GeminiSpawner — Spawns the Google Gemini CLI.
 *
 * Command: `gemini --yolo [--model {model}]`
 * Input: prompt via stdin
 * Output: plain text stdout
 */
export class GeminiSpawner implements WorkerSpawner {
  spawn(prompt: string, config: SpawnRunConfig): SpawnHandle {
    const args = ['--yolo'];
    if (config.model) args.push('--model', config.model);
    return spawnWithPipe('gemini', args, prompt, config.workingDirectory, config.timeoutMs, (s) => s.trim(), config.env);
  }

  isAvailable(): boolean {
    return isBinaryAvailable('gemini');
  }

  defaultModel(): string {
    return 'gemini-2.5-pro';
  }
}

/**
 * ClaudeCodeSpawner — Spawns Claude Code CLI in non-interactive print mode.
 *
 * Command: `claude --dangerously-skip-permissions -p`
 * Input: prompt via stdin (piped to -p flag)
 * Output: plain text stdout
 */
export class ClaudeCodeSpawner implements WorkerSpawner {
  spawn(prompt: string, config: SpawnRunConfig): SpawnHandle {
    const args = ['--dangerously-skip-permissions', '-p'];
    if (config.model) args.push('--model', config.model);
    return spawnWithPipe('claude', args, prompt, config.workingDirectory, config.timeoutMs, (s) => s.trim(), config.env);
  }

  isAvailable(): boolean {
    return isBinaryAvailable('claude');
  }

  defaultModel(): string {
    // Claude Code inherits model from user config; no hardcoded default
    return 'claude-sonnet-4-20250514';
  }
}

/** Spawner instances (singletons — stateless, safe to reuse) */
const spawners: Record<string, WorkerSpawner> = {
  codex: new CodexSpawner(),
  gemini: new GeminiSpawner(),
  claude: new ClaudeCodeSpawner(),
};

/**
 * Factory: get a WorkerSpawner by provider name.
 * Throws if the provider is unknown.
 */
export function getSpawner(provider: string): WorkerSpawner {
  const spawner = spawners[provider];
  if (!spawner) {
    throw new Error(`Unknown spawner provider: "${provider}". Valid providers: ${Object.keys(spawners).join(', ')}`);
  }
  return spawner;
}
