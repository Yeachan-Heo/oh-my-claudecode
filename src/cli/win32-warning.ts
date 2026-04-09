import chalk from 'chalk';
import { isTmuxAvailable } from './tmux-utils.js';

/**
 * Warn if running on native Windows (win32) without tmux available.
 * Called at CLI startup from src/cli/index.ts.
 * If a tmux-compatible binary (e.g. psmux) is on PATH, the warning is skipped.
 */
export function warnIfWin32(): void {
  if (process.platform === 'win32' && !isTmuxAvailable()) {
    console.warn(chalk.yellow.bold('\n⚠  WARNING: Native Windows (win32) detected — no tmux found'));
    console.warn(chalk.yellow('   OMC features that require tmux will not work.'));
    console.warn(chalk.yellow('   Install psmux for native Windows tmux support: winget install psmux'));
    console.warn(chalk.yellow('   Or use WSL2: https://learn.microsoft.com/en-us/windows/wsl/install'));
    console.warn('');
  }
}
