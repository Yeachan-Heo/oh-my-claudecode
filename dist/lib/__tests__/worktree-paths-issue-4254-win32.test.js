/**
 * Regression for #4254: a session started in a SUBDIRECTORY of a git repo must
 * resolve the HUD working directory the same way a session started at the repo
 * root does. On Windows, git reports the toplevel as `D:/repo` while Node paths
 * use `D:\repo`, so raw string comparisons of the two rejected the repo's own
 * root as a cross-repository path.
 *
 * Uses a real git repository and no probe mocks so the Windows CI job
 * (ci.yml `test-windows`) exercises real git output and real realpath results.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearWorktreeCache, resolveToWorktreeRoot, validateWorkingDirectory, } from '../worktree-paths.js';
function samePath(a, b) {
    const norm = (p) => {
        const real = realpathSync.native(p).replace(/\\/g, '/');
        return process.platform === 'win32' ? real.toLowerCase() : real;
    };
    return norm(a) === norm(b);
}
describe('#4254: session cwd in a repository subdirectory', () => {
    let root;
    let repo;
    let nested;
    let originalCwd;
    beforeEach(() => {
        originalCwd = process.cwd();
        root = mkdtempSync(join(tmpdir(), 'omc-4254-'));
        repo = join(root, 'repo');
        nested = join(repo, 'pkg', 'app');
        mkdirSync(nested, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
        clearWorktreeCache();
    });
    afterEach(() => {
        process.chdir(originalCwd);
        clearWorktreeCache();
        rmSync(root, { recursive: true, force: true });
    });
    it('resolves the HUD working directory to the repo root from a nested subdirectory', () => {
        process.chdir(nested);
        const worktreeRoot = resolveToWorktreeRoot(nested);
        expect(samePath(worktreeRoot, repo)).toBe(true);
        const validated = validateWorkingDirectory(worktreeRoot);
        expect(samePath(validated, repo)).toBe(true);
    });
    it('accepts the nested subdirectory itself as a working directory', () => {
        process.chdir(nested);
        expect(() => validateWorkingDirectory(nested)).not.toThrow();
    });
    it('still refuses to switch to a different repository', () => {
        const other = join(root, 'other');
        mkdirSync(other, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'pipe' });
        process.chdir(nested);
        const validated = validateWorkingDirectory(other);
        expect(samePath(validated, other)).toBe(false);
        expect(samePath(validated, repo)).toBe(true);
    });
});
//# sourceMappingURL=worktree-paths-issue-4254-win32.test.js.map