#!/usr/bin/env tsx
/**
 * Ralph Fresh Context Orchestrator v0.1
 *
 * External loop spawning fresh Claude Code instances.
 * Handles: latency bugs, retries, graceful shutdown.
 *
 * Usage:
 *   ./scripts/ralph-fresh.ts "Build a todo app" [options]
 *
 * Options:
 *   --max-iterations <n>  Max iterations (default: 20)
 *   --max-turns <n>       Max turns per iteration (default: 100)
 *   --verbose             Verbose output
 *   --prd                 PRD mode flag (reserved for future use)
 */

import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  initHandoff,
  readHandoff,
  writeHandoff,
  refreshHandoffFromFiles,
  clearHandoff,
  type RalphFreshHandoff
} from '../src/hooks/ralph/fresh-handoff.js';
import { generateIterationPrompt } from '../src/hooks/ralph/fresh-prompt.js';
import { isStandardRalphActive } from '../src/hooks/ralph/fresh.js';

// ============================================================================
// Configuration
// ============================================================================

export interface RalphFreshScriptConfig {
  maxIterations: number;
  maxTurnsPerIteration: number;
  completionPromise: string;
  workingDir: string;
  verbose: boolean;
  retryAttempts: number;
  retryDelayMs: number;
  stuckThreshold: number;
  prompt?: string; // For initOrLoadHandoff
}

const DEFAULT_CONFIG: Partial<RalphFreshScriptConfig> = {
  maxIterations: 20,
  maxTurnsPerIteration: 100,
  completionPromise: 'TASK_COMPLETE',
  workingDir: process.cwd(),
  verbose: false,
  retryAttempts: 3,
  retryDelayMs: 5000,
  stuckThreshold: 3
};

// ============================================================================
// Graceful Shutdown
// ============================================================================

let shutdownRequested = false;

export function setupSignalHandlers(config: RalphFreshScriptConfig): void {
  const handler = (signal: string) => {
    console.log(`\n[Ralph Fresh] Received ${signal}, saving state and exiting...`);
    shutdownRequested = true;
    // State will be saved in main loop
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

export function parseArgs(): { prompt: string; config: RalphFreshScriptConfig } {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    throw new Error('No prompt provided. Usage: ralph-fresh.ts "<prompt>" [options]');
  }

  let prompt = '';
  const config: RalphFreshScriptConfig = {
    ...DEFAULT_CONFIG,
    workingDir: process.cwd()
  } as RalphFreshScriptConfig;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--max-iterations' && i + 1 < args.length) {
      config.maxIterations = parseInt(args[++i], 10);
    } else if (arg === '--max-turns' && i + 1 < args.length) {
      config.maxTurnsPerIteration = parseInt(args[++i], 10);
    } else if (arg === '--verbose') {
      config.verbose = true;
    } else if (arg === '--prd') {
      // Reserved for future PRD mode flag
      console.log('[Ralph Fresh] PRD mode flag noted (reserved for future use)');
    } else if (!arg.startsWith('--')) {
      // First non-flag argument is the prompt
      if (!prompt) {
        prompt = arg;
      }
    }
  }

  if (!prompt) {
    throw new Error('No prompt provided. Usage: ralph-fresh.ts "<prompt>" [options]');
  }

  config.prompt = prompt;

  return { prompt, config };
}

// ============================================================================
// Helper Functions
// ============================================================================

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractCompletionMessage(output: string): string {
  // Look for text after the promise tag
  const match = output.match(/<promise>.*?<\/promise>\s*([\s\S]*)/i);
  if (match && match[1]) {
    const text = match[1].trim();
    // Only return if there's meaningful content (not just generic text)
    if (text && text.length > 10) {
      return text.slice(0, 500); // Limit to 500 chars
    }
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanup(dir: string): void {
  // Clear handoff state on successful completion
  clearHandoff(dir);
  console.log('[Ralph Fresh] Cleaned up handoff state');
}

// ============================================================================
// Handoff Initialization
// ============================================================================

export function initOrLoadHandoff(config: RalphFreshScriptConfig): RalphFreshHandoff {
  const existingHandoff = readHandoff(config.workingDir);

  if (existingHandoff) {
    console.log(`[Ralph Fresh] Resuming from iteration ${existingHandoff.iteration}`);
    return existingHandoff;
  }

  console.log('[Ralph Fresh] Initializing new handoff state');
  return initHandoff(config.prompt || '', {
    maxIterations: config.maxIterations,
    completionPromise: config.completionPromise,
    stuckThreshold: config.stuckThreshold
  });
}

// ============================================================================
// Claude Execution
// ============================================================================

export async function runClaude(
  prompt: string,
  config: RalphFreshScriptConfig
): Promise<{ success: boolean; output: string; sessionId?: string }> {
  const promptFile = join(config.workingDir, '.omc', 'state', 'iteration-prompt.txt');
  const stateDir = join(config.workingDir, '.omc', 'state');

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  writeFileSync(promptFile, prompt);

  const args = [
    '-p',
    '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
    '--output-format', 'json',
    '--max-turns', String(config.maxTurnsPerIteration)
  ];

  if (config.verbose) {
    args.push('--verbose');
  }

  const execOptions: ExecSyncOptions = {
    cwd: config.workingDir,
    encoding: 'utf-8',
    timeout: 45 * 60 * 1000, // 45 min (accounting for 60s latency bug)
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 50 * 1024 * 1024 // 50MB buffer for large outputs
  };

  for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
    try {
      // Pipe prompt from stdin to avoid shell escaping
      const result = execSync(
        `cat "${promptFile}" | claude ${args.join(' ')}`,
        execOptions
      );

      // Ensure result is a string
      const resultStr = typeof result === 'string' ? result : result.toString();

      // Parse JSON output
      try {
        const parsed = JSON.parse(resultStr);
        return {
          success: true,
          output: parsed.result || resultStr,
          sessionId: parsed.session_id
        };
      } catch {
        // Non-JSON output, use raw
        return { success: true, output: resultStr };
      }

    } catch (error: any) {
      const errorMsg = error.message || String(error);

      // Check for known retryable errors
      if (errorMsg.includes('tool_use ids must be unique') ||
          errorMsg.includes('tool use concurrency')) {
        console.log(`[Ralph Fresh] Retryable error (attempt ${attempt}/${config.retryAttempts}): ${errorMsg}`);

        if (attempt < config.retryAttempts) {
          await sleep(config.retryDelayMs);
          continue;
        }
      }

      // Non-retryable or max retries exceeded
      return {
        success: false,
        output: errorMsg
      };
    }
  }

  return { success: false, output: 'Max retries exceeded' };
}

// ============================================================================
// Main Orchestration Loop
// ============================================================================

async function main(): Promise<void> {
  // Check for conflicting standard ralph
  if (isStandardRalphActive(process.cwd())) {
    console.error('[Ralph Fresh] ERROR: Standard ralph is already active. Cannot run fresh-context mode.');
    console.error('[Ralph Fresh] Cancel the existing ralph session first.');
    process.exit(1);
  }

  const { prompt, config } = parseArgs();
  setupSignalHandlers(config);

  console.log('[Ralph Fresh] Starting fresh-context orchestration');
  console.log(`[Ralph Fresh] Max iterations: ${config.maxIterations}`);
  console.log(`[Ralph Fresh] Stuck threshold: ${config.stuckThreshold}`);

  let handoff = initOrLoadHandoff(config);

  while (
    handoff.iteration <= handoff.max_iterations &&
    !handoff.completed &&
    !shutdownRequested
  ) {
    console.log(`\n[Ralph Fresh] === Iteration ${handoff.iteration}/${handoff.max_iterations} ===`);

    // Refresh state from files (PRD, progress, git)
    handoff = refreshHandoffFromFiles(handoff, config.workingDir);

    // Check PRD completion before spawning
    if (handoff.prd && handoff.prd.storiesCompleted === handoff.prd.storiesTotal) {
      console.log('[Ralph Fresh] All PRD stories complete!');
      handoff.completed = true;
      break;
    }

    // Check stuck state
    if (handoff.stuckDetection.iterationsOnSameStory >= config.stuckThreshold) {
      console.log(`[Ralph Fresh] WARNING: Stuck on story ${handoff.prd?.nextStoryId} for ${handoff.stuckDetection.iterationsOnSameStory} iterations`);
      // Continue anyway - the prompt warns the agent
    }

    // Save state before iteration
    writeHandoff(handoff, config.workingDir);

    // Generate iteration prompt
    const iterationPrompt = generateIterationPrompt(handoff as any);

    // Spawn fresh Claude instance
    console.log('[Ralph Fresh] Spawning fresh Claude instance...');
    const result = await runClaude(iterationPrompt, config);

    if (!result.success) {
      console.log(`[Ralph Fresh] Iteration failed: ${result.output}`);
      handoff.lastError = {
        iteration: handoff.iteration,
        message: result.output
      };
      // Continue to next iteration anyway
    }

    // Check for completion promise
    const promisePattern = new RegExp(
      `<promise>\\s*${escapeRegex(handoff.completion_promise)}\\s*</promise>`,
      'is'
    );

    if (promisePattern.test(result.output)) {
      console.log('[Ralph Fresh] Completion promise detected!');
      handoff.completed = true;
      handoff.completion_message = extractCompletionMessage(result.output);
      break;
    }

    // Prepare next iteration
    handoff.iteration++;
  }

  // Save final state
  writeHandoff(handoff, config.workingDir);

  // Report result
  if (shutdownRequested) {
    console.log('\n[Ralph Fresh] Shutdown requested. State saved for resume.');
    process.exit(130); // Standard exit code for SIGINT
  } else if (handoff.completed) {
    console.log(`\n[Ralph Fresh] ✅ COMPLETE after ${handoff.iteration} iterations`);
    if (handoff.completion_message) {
      console.log(`\nCompletion message:\n${handoff.completion_message}`);
    }
    cleanup(config.workingDir);
    process.exit(0);
  } else {
    console.log(`\n[Ralph Fresh] ⚠️ Max iterations (${handoff.max_iterations}) reached without completion`);
    process.exit(1);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

if (require.main === module) {
  main().catch(err => {
    console.error('[Ralph Fresh] Fatal error:', err);
    process.exit(1);
  });
}
