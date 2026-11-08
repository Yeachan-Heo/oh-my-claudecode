/**
 * Verification test: ensures no raw tmux child_process calls exist outside tmux-utils.ts.
 *
 * Every tmux call in the codebase must go through the centralized wrappers
 * (tmuxExec, tmuxExecAsync, tmuxShell, tmuxShellAsync, tmuxSpawn, tmuxCmdAsync)
 * defined in src/cli/tmux-utils.ts. This test enforces that invariant.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
function grepForRawTmuxCalls() {
    const srcDir = join(__dirname, '..', '..');
    // Patterns that match raw tmux calls via child_process functions.
    // Covers both single-quote and double-quote variants.
    const patterns = [
        "execFileSync\\s*\\(\\s*['\"]tmux",
        "execSync\\s*\\(\\s*['\"`]tmux",
        "spawnSync\\s*\\(\\s*['\"]tmux",
        "execFile\\s*\\(\\s*['\"]tmux",
        "\\bexec\\s*\\(\\s*[`'\"]tmux",
    ];
    const combined = patterns.join('|');
    try {
        const result = execSync(`grep -rn --include='*.ts' -E '${combined}' '${srcDir}' || true`, { encoding: 'utf-8', timeout: 10000 });
        return result
            .split('\n')
            .filter(Boolean)
            // Exclude the wrapper implementations in tmux-utils.ts itself
            .filter(line => !line.includes('cli/tmux-utils.ts'))
            // Exclude test files
            .filter(line => !line.includes('__tests__/'))
            // Exclude comments (lines starting with optional whitespace then * or //)
            .filter(line => {
            const content = line.split(':').slice(2).join(':').trim();
            return !content.startsWith('*') && !content.startsWith('//');
        });
    }
    catch {
        return [];
    }
}
describe('tmux call centralization', () => {
    it('has zero raw tmux child_process calls outside tmux-utils.ts and test files', () => {
        const violations = grepForRawTmuxCalls();
        if (violations.length > 0) {
            const formatted = violations.map(v => `  ${v}`).join('\n');
            expect.fail(`Found ${violations.length} raw tmux call(s) outside tmux-utils.ts:\n${formatted}\n\n` +
                'All tmux calls must use the centralized wrappers (tmuxExec, tmuxExecAsync, etc.) from src/cli/tmux-utils.ts.');
        }
        expect(violations).toHaveLength(0);
    });
});
//# sourceMappingURL=tmux-no-raw-calls.test.js.map