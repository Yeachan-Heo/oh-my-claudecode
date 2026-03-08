import chalk from 'chalk';
import { spawnSync } from 'child_process';
/**
 * Check if tmux (or a compatible implementation like psmux) is available.
 */
function hasTmuxBinary() {
    try {
        const result = spawnSync('tmux', ['-V'], { stdio: 'pipe', timeout: 3000 });
        return result.status === 0;
    }
    catch {
        return false;
    }
}
/**
 * Warn if running on native Windows (win32) without tmux available.
 * Called at CLI startup from src/cli/index.ts.
 * If a tmux-compatible binary (e.g. psmux) is on PATH, the warning is skipped.
 */
export function warnIfWin32() {
    if (process.platform === 'win32' && !hasTmuxBinary()) {
        console.warn(chalk.yellow.bold('\n⚠  WARNING: Native Windows (win32) detected — no tmux found'));
        console.warn(chalk.yellow('   OMC features that require tmux will not work.'));
        console.warn(chalk.yellow('   Install psmux for native Windows tmux support: winget install psmux'));
        console.warn(chalk.yellow('   Or use WSL2: https://learn.microsoft.com/en-us/windows/wsl/install'));
        console.warn('');
    }
}
//# sourceMappingURL=win32-warning.js.map