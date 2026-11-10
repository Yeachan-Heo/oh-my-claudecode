/**
 * Regression: team runtime writes must not false-positive "Path traversal
 * detected" in a multi-repo .omc-workspace layout.
 *
 * In that layout the shared .omc root lives at the workspace anchor (the parent
 * of each sub-repo), so paths built with getOmcRoot(subRepo) resolve ABOVE the
 * sub-repo. Validation that used the sub-repo as the allowed base threw and
 * dropped team metadata / audit / usage / restart / worktree state.
 *
 * Setup mirrors the reviewer's reproduction: parent/.omc-workspace + parent/api.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { clearWorktreeCache } from '../../lib/worktree-paths.js';
import { createWorkerWorktree, listTeamWorktrees, cleanupTeamWorktrees, installWorktreeRootAgents, restoreWorktreeRootAgents, } from '../git-worktree.js';
describe('multi-repo workspace team writes', () => {
    let parent;
    let api;
    const teamName = 'multi-repo-team';
    beforeEach(() => {
        clearWorktreeCache();
        // Non-git parent holding the workspace marker, with a git sub-repo inside.
        parent = mkdtempSync(join(homedir(), 'omc-multirepo-team-'));
        writeFileSync(join(parent, '.omc-workspace'), '{}');
        api = join(parent, 'api');
        mkdirSync(api, { recursive: true });
        execFileSync('git', ['init'], { cwd: api, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: api, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: api, stdio: 'pipe' });
        writeFileSync(join(api, 'README.md'), '# api\n');
        execFileSync('git', ['add', '.'], { cwd: api, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: api, stdio: 'pipe' });
        clearWorktreeCache();
    });
    afterEach(() => {
        try {
            cleanupTeamWorktrees(teamName, api);
        }
        catch { /* ignore */ }
        clearWorktreeCache();
        if (parent)
            rmSync(parent, { recursive: true, force: true });
    });
    const sharedOmc = () => join(parent, '.omc');
    it('worktree creation + metadata + AGENTS overlay work from the sub-repo', () => {
        let info;
        expect(() => {
            info = createWorkerWorktree(teamName, 'worker1', api);
        }).not.toThrow();
        // Worktree and metadata live under the shared workspace .omc, above the repo.
        expect(info.path.startsWith(join(sharedOmc(), 'team'))).toBe(true);
        expect(existsSync(info.path)).toBe(true);
        expect(existsSync(join(sharedOmc(), 'state', 'team', teamName, 'worktrees.json'))).toBe(true);
        expect(listTeamWorktrees(teamName, api).map(w => w.workerName)).toContain('worker1');
        expect(() => installWorktreeRootAgents(teamName, 'worker1', api, info.path, '# overlay\n')).not.toThrow();
        expect(() => restoreWorktreeRootAgents(teamName, 'worker1', api, info.path)).not.toThrow();
    });
});
//# sourceMappingURL=multirepo-workspace-team.test.js.map