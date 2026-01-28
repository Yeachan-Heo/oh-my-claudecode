/**
 * Ralph-Fresh CLI Command
 *
 * CLI command wrapper for ralph-fresh mode.
 * This allows running ralph-fresh from the command line (e.g., for testing).
 *
 * NOTE: Ralph-fresh is typically invoked via the /oh-my-claudecode:ralph-fresh
 * slash command within Claude Code. This CLI command is primarily for
 * development and testing purposes.
 */

import chalk from 'chalk';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { isModeActive, MODE_CONFIGS } from '../../hooks/mode-registry/index.js';

export interface RalphFreshOptions {
  maxIterations?: number;
  verbose?: boolean;
  prd?: boolean;
  json?: boolean;
}

/**
 * CLI command for ralph-fresh
 *
 * Checks for mutual exclusion with standard ralph and other modes,
 * then spawns the orchestrator script.
 */
export async function ralphFreshCommand(
  prompt: string,
  options: RalphFreshOptions
): Promise<void> {
  const cwd = process.cwd();

  // Check if standard ralph is active - mutual exclusion
  if (isModeActive('ralph', cwd)) {
    console.error(chalk.red('✗ Standard Ralph is currently active'));
    console.error(chalk.yellow('  Ralph and Ralph-Fresh are mutually exclusive.'));
    console.error(chalk.gray('  Cancel the running Ralph session first with: /oh-my-claudecode:cancel'));
    process.exit(1);
  }

  // Check for other active exclusive modes
  const exclusiveModes = ['autopilot', 'ultrapilot', 'swarm', 'pipeline'] as const;
  for (const mode of exclusiveModes) {
    if (isModeActive(mode, cwd)) {
      const config = MODE_CONFIGS[mode];
      console.error(chalk.red(`✗ ${config.name} is currently active`));
      console.error(chalk.yellow('  Ralph-Fresh cannot run while another exclusive mode is active.'));
      console.error(chalk.gray(`  Cancel ${config.name} first with: /oh-my-claudecode:cancel`));
      process.exit(1);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      mode: 'ralph-fresh',
      prompt,
      options: {
        maxIterations: options.maxIterations || 20,
        prd: options.prd || false,
        verbose: options.verbose || false
      }
    }, null, 2));
    return;
  }

  // Execute the orchestrator script
  await executeOrchestratorScript(prompt, options, cwd);
}

/**
 * Execute the ralph-fresh orchestrator script
 */
async function executeOrchestratorScript(
  prompt: string,
  options: RalphFreshOptions,
  cwd: string
): Promise<void> {
  // Resolve script path relative to this file
  // In development: src/cli/commands/ralph-fresh.ts
  // In production: dist/cli/commands/ralph-fresh.js
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFilePath);

  // Navigate up to project root
  // From dist/cli/commands or src/cli/commands -> project root is 3 levels up
  const projectRoot = join(currentDir, '..', '..', '..');

  // Try tsx for development, node for production
  const tsScriptPath = join(projectRoot, 'scripts', 'ralph-fresh.ts');
  const jsScriptPath = join(projectRoot, 'scripts', 'ralph-fresh.js');

  let command: string;
  let scriptPath: string;

  if (existsSync(tsScriptPath)) {
    // Development mode - use tsx
    command = 'tsx';
    scriptPath = tsScriptPath;
  } else if (existsSync(jsScriptPath)) {
    // Production mode - use node
    command = 'node';
    scriptPath = jsScriptPath;
  } else {
    console.error(chalk.red('✗ Ralph-Fresh orchestrator script not found'));
    console.error(chalk.gray(`  Expected at: ${tsScriptPath} or ${jsScriptPath}`));
    process.exit(1);
    return;
  }

  // Build arguments
  const args: string[] = [scriptPath, prompt];

  if (options.maxIterations) {
    args.push('--max-iterations', String(options.maxIterations));
  }

  if (options.verbose) {
    args.push('--verbose');
  }

  if (options.prd) {
    args.push('--prd');
  }

  console.log(chalk.blue.bold('\n🔄 Starting Ralph-Fresh Orchestrator\n'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.gray(`Prompt: ${prompt}`));
  console.log(chalk.gray(`Max Iterations: ${options.maxIterations || 20}`));
  console.log(chalk.gray(`PRD Mode: ${options.prd ? 'enabled' : 'disabled'}`));
  console.log(chalk.gray(`Verbose: ${options.verbose ? 'enabled' : 'disabled'}`));
  console.log(chalk.gray('─'.repeat(50) + '\n'));

  // Spawn the orchestrator script
  return new Promise<void>((resolve, reject) => {
    const childProcess = spawn(command, args, {
      cwd,
      stdio: 'inherit'
    });

    childProcess.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        process.exit(code || 1);
      }
    });

    childProcess.on('error', (error) => {
      console.error(chalk.red('✗ Failed to spawn orchestrator:'), error.message);
      reject(error);
    });
  });
}
