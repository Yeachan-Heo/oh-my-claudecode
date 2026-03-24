/**
 * omc ralphthon CLI subcommand
 *
 * Autonomous hackathon lifecycle:
 *   omc ralphthon "task"                  Start new ralphthon session
 *   omc ralphthon --resume                Resume existing session
 *   omc ralphthon --skip-interview "task" Skip deep-interview, use task directly
 *   omc ralphthon --max-waves 5           Set max hardening waves
 *   omc ralphthon --poll-interval 60      Set poll interval in seconds
 */

import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import {
  readRalphthonPrd,
  readRalphthonState,
  writeRalphthonState,
  clearRalphthonState,
  initOrchestrator,
  startOrchestratorLoop,
  formatRalphthonStatus,
  getRalphthonPrdPath,
  initRalphthonPrd,
  sendKeysToPane,
} from '../../ralphthon/index.js';
import type {
  RalphthonCliOptions,
  OrchestratorEvent,
  RalphthonConfig,
} from '../../ralphthon/types.js';
import { RALPHTHON_DEFAULTS } from '../../ralphthon/types.js';

// ============================================================================
// Help Text
// ============================================================================

const RALPHTHON_HELP = `
Usage: omc ralphthon [options] [task]

Autonomous hackathon lifecycle mode.
Generates PRD via deep-interview, executes all tasks with ralph loop,
then auto-hardens until clean.

Options:
  --resume              Resume an existing ralphthon session
  --skip-interview      Skip deep-interview, start execution directly
  --max-waves <n>       Maximum hardening waves (default: ${RALPHTHON_DEFAULTS.maxWaves})
  --poll-interval <s>   Poll interval in seconds (default: ${RALPHTHON_DEFAULTS.pollIntervalMs / 1000})
  --help, -h            Show this help

Examples:
  omc ralphthon "Build a REST API for user management"
  omc ralphthon --skip-interview "Implement auth middleware"
  omc ralphthon --resume
  omc ralphthon --max-waves 5 --poll-interval 60 "Add caching layer"
`;

// ============================================================================
// Argument Parsing
// ============================================================================

/**
 * Parse ralphthon CLI arguments
 */
export function parseRalphthonArgs(args: string[]): RalphthonCliOptions {
  const options: RalphthonCliOptions = {
    resume: false,
    skipInterview: false,
    maxWaves: RALPHTHON_DEFAULTS.maxWaves,
    pollInterval: RALPHTHON_DEFAULTS.pollIntervalMs / 1000,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--resume':
        options.resume = true;
        break;
      case '--skip-interview':
        options.skipInterview = true;
        break;
      case '--max-waves': {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val) && val > 0) options.maxWaves = val;
        break;
      }
      case '--poll-interval': {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val) && val > 0) options.pollInterval = val;
        break;
      }
      case '--help':
      case '-h':
        console.log(RALPHTHON_HELP);
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('--')) {
          positional.push(arg);
        }
        break;
    }
  }

  if (positional.length > 0) {
    options.task = positional.join(' ');
  }

  return options;
}

// ============================================================================
// Event Handler
// ============================================================================

function createEventLogger(): (event: OrchestratorEvent) => void {
  return (event: OrchestratorEvent) => {
    const ts = new Date().toLocaleTimeString();

    switch (event.type) {
      case 'task_injected':
        console.log(chalk.cyan(`[${ts}] Task injected: ${event.taskTitle}`));
        break;
      case 'task_completed':
        console.log(chalk.green(`[${ts}] Task completed: ${event.taskId}`));
        break;
      case 'task_failed':
        console.log(chalk.yellow(`[${ts}] Task failed: ${event.taskId} (retry ${event.retries})`));
        break;
      case 'task_skipped':
        console.log(chalk.red(`[${ts}] Task skipped: ${event.taskId} — ${event.reason}`));
        break;
      case 'phase_transition':
        console.log(chalk.magenta(`[${ts}] Phase: ${event.from} -> ${event.to}`));
        break;
      case 'hardening_wave_start':
        console.log(chalk.blue(`[${ts}] Hardening wave ${event.wave} started`));
        break;
      case 'hardening_wave_end':
        console.log(chalk.blue(`[${ts}] Hardening wave ${event.wave} ended — ${event.newIssues} new issues`));
        break;
      case 'idle_detected':
        console.log(chalk.gray(`[${ts}] Leader idle for ${Math.round(event.durationMs / 1000)}s`));
        break;
      case 'session_complete':
        console.log(chalk.green.bold(`[${ts}] Ralphthon complete! ${event.tasksCompleted} done, ${event.tasksSkipped} skipped`));
        break;
      case 'error':
        console.log(chalk.red(`[${ts}] Error: ${event.message}`));
        break;
    }
  };
}

// ============================================================================
// Tmux Helpers
// ============================================================================

function getCurrentTmuxSession(): string | null {
  try {
    return execSync("tmux display-message -p '#S'", { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getCurrentTmuxPane(): string | null {
  try {
    return execSync("tmux display-message -p '#{pane_id}'", { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

// ============================================================================
// Main Command
// ============================================================================

/**
 * Execute the ralphthon CLI command
 */
export async function ralphthonCommand(args: string[]): Promise<void> {
  const options = parseRalphthonArgs(args);
  const cwd = process.cwd();

  // Resume mode
  if (options.resume) {
    const state = readRalphthonState(cwd);
    if (!state || !state.active) {
      console.error(chalk.red('No active ralphthon session found to resume.'));
      process.exit(1);
    }

    console.log(chalk.blue('Resuming ralphthon session...'));
    const prd = readRalphthonPrd(cwd);
    if (prd) {
      console.log(formatRalphthonStatus(prd));
    }

    const eventLogger = createEventLogger();
    const { stop } = startOrchestratorLoop(cwd, state.sessionId, eventLogger);

    // Handle graceful shutdown
    const shutdown = () => {
      console.log(chalk.yellow('\nStopping ralphthon orchestrator...'));
      stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return;
  }

  // New session — need task description
  if (!options.task) {
    console.error(chalk.red('Task description required. Usage: omc ralphthon "your task"'));
    console.log(RALPHTHON_HELP);
    process.exit(1);
  }

  // Must be inside tmux
  if (!isInsideTmux()) {
    console.error(chalk.red('Ralphthon requires tmux. Run inside a tmux session or use `omc` to launch one.'));
    process.exit(1);
  }

  const tmuxSession = getCurrentTmuxSession();
  const leaderPane = getCurrentTmuxPane();

  if (!tmuxSession || !leaderPane) {
    console.error(chalk.red('Could not detect tmux session/pane.'));
    process.exit(1);
  }

  // Check for existing session
  const existingState = readRalphthonState(cwd);
  if (existingState?.active) {
    console.error(chalk.red('A ralphthon session is already active. Use --resume or cancel it first.'));
    process.exit(1);
  }

  const sessionId = `ralphthon-${Date.now()}`;
  const config: Partial<RalphthonConfig> = {
    maxWaves: options.maxWaves,
    pollIntervalMs: options.pollInterval * 1000,
    skipInterview: options.skipInterview,
  };

  console.log(chalk.blue.bold('Starting Ralphthon'));
  console.log(chalk.gray(`Task: ${options.task}`));
  console.log(chalk.gray(`Max waves: ${options.maxWaves}, Poll: ${options.pollInterval}s`));
  console.log(chalk.gray(`Skip interview: ${options.skipInterview}`));

  // Phase 1: Interview (unless skipped)
  if (!options.skipInterview) {
    console.log(chalk.cyan('\nPhase 1: Deep Interview — generating PRD...'));
    console.log(chalk.gray('The leader pane will run deep-interview to generate the PRD.'));

    // Inject deep-interview command to the leader pane
    // The orchestrator will wait for the PRD to appear
    // Sanitize task to prevent newline/control char injection via tmux send-keys
    const sanitizedTask = options.task!.replace(/[\r\n\0]+/g, ' ').trim();
    const interviewPrompt = `/deep-interview ${sanitizedTask}

After the interview, generate a ralphthon-prd.json file in .omc/ with this structure:
{
  "project": "<project name>",
  "branchName": "<branch>",
  "description": "<description>",
  "stories": [{ "id": "US-001", "title": "...", "description": "...", "acceptanceCriteria": [...], "priority": "high", "tasks": [{ "id": "T-001", "title": "...", "description": "...", "status": "pending", "retries": 0 }] }],
  "hardening": [],
  "config": { "maxWaves": ${options.maxWaves}, "cleanWavesForTermination": 3, "pollIntervalMs": ${options.pollInterval * 1000}, "idleThresholdMs": 30000, "maxRetries": 3, "skipInterview": false }
}`;

    // Initialize state in interview phase
    const state = initOrchestrator(
      cwd,
      tmuxSession,
      leaderPane,
      getRalphthonPrdPath(cwd),
      sessionId,
      config,
    );
    state.phase = 'interview';
    writeRalphthonState(cwd, state, sessionId);

    // Send the deep-interview prompt to the leader pane
    if (!sendKeysToPane(leaderPane, interviewPrompt)) {
      console.log(chalk.red('Failed to inject deep-interview prompt to leader pane.'));
      clearRalphthonState(cwd, sessionId);
      process.exit(1);
    }

    console.log(chalk.gray('Waiting for PRD generation...'));

    // Poll for PRD file to appear
    const prdPath = getRalphthonPrdPath(cwd);
    const maxWaitMs = 600_000; // 10 minutes max wait for interview
    const pollMs = 5_000;
    let waited = 0;

    while (waited < maxWaitMs) {
      if (existsSync(prdPath)) {
        const prd = readRalphthonPrd(cwd);
        if (prd && prd.stories.length > 0) {
          console.log(chalk.green('PRD generated successfully!'));
          console.log(formatRalphthonStatus(prd));
          break;
        }
      }
      await sleep(pollMs);
      waited += pollMs;
    }

    if (waited >= maxWaitMs) {
      console.error(chalk.red('Timed out waiting for PRD generation.'));
      clearRalphthonState(cwd, sessionId);
      process.exit(1);
    }
  } else {
    // Skip interview — create a simple PRD from the task
    console.log(chalk.cyan('\nSkipping interview — creating PRD from task...'));

    initRalphthonPrd(cwd, 'ralphthon', 'feat/ralphthon', options.task, [
      {
        id: 'US-001',
        title: options.task.slice(0, 60),
        description: options.task,
        acceptanceCriteria: ['Implementation complete', 'Tests pass', 'No type errors'],
        priority: 'high',
        tasks: [
          {
            id: 'T-001',
            title: options.task.slice(0, 60),
            description: options.task,
            status: 'pending',
            retries: 0,
          },
        ],
      },
    ], config);

    initOrchestrator(
      cwd,
      tmuxSession,
      leaderPane,
      getRalphthonPrdPath(cwd),
      sessionId,
      config,
    );
  }

  // Phase 2: Execution — start the orchestrator loop
  console.log(chalk.cyan('\nPhase 2: Execution — ralph loop active'));

  const eventLogger = createEventLogger();
  const { stop } = startOrchestratorLoop(cwd, sessionId, eventLogger);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(chalk.yellow('\nStopping ralphthon orchestrator...'));
    stop();
    clearRalphthonState(cwd, sessionId);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  console.log(chalk.gray('Orchestrator running. Press Ctrl+C to stop.'));
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
