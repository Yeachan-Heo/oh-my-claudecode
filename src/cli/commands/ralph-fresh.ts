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
 * then provides guidance on how to use ralph-fresh.
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
      },
      error: 'CLI execution not yet implemented'
    }, null, 2));
    return;
  }

  console.log(chalk.blue.bold('\n🔄 Ralph-Fresh Mode\n'));
  console.log(chalk.gray('─'.repeat(50)));

  console.log(chalk.yellow('\nℹ️  Ralph-Fresh is designed to run within Claude Code.\n'));

  console.log(chalk.white('To use Ralph-Fresh:'));
  console.log(chalk.cyan('  1. Start Claude Code in this directory'));
  console.log(chalk.cyan('  2. Use the slash command: /oh-my-claudecode:ralph-fresh'));
  console.log(chalk.cyan('  3. Provide your task prompt when asked\n'));

  console.log(chalk.gray('Task Details:'));
  console.log(chalk.gray(`  Prompt: ${prompt}`));
  console.log(chalk.gray(`  Max Iterations: ${options.maxIterations || 20}`));
  console.log(chalk.gray(`  PRD Mode: ${options.prd ? 'enabled' : 'disabled'}`));
  console.log(chalk.gray(`  Verbose: ${options.verbose ? 'enabled' : 'disabled'}`));

  console.log(chalk.gray('\n─'.repeat(50)));
  console.log(chalk.dim('\nAlternatively, use the ralph-fresh skill within an active Claude Code session.'));
}
