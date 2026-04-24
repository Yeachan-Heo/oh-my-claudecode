import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createWorkerWorktree, removeWorkerWorktree, listTeamWorktrees, cleanupTeamWorktrees, ensureWorkerWorktree, installWorktreeRootAgents, restoreWorktreeRootAgents, prepareWorkerWorktreeForRemoval, } from '../git-worktree.js';
describe('git-worktree', () => {
    let repoDir;
    const teamName = 'test-wt';
    beforeEach(() => {
        repoDir = mkdtempSync(join(tmpdir(), 'git-worktree-test-'));
        // Initialize a git repo with an initial commit
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
        writeFileSync(join(repoDir, 'README.md'), '# Test\n');
        writeFileSync(join(repoDir, 'AGENTS.md'), 'original instructions');
        execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });
    });
    afterEach(() => {
        // Clean up worktrees first (git needs this before rmSync)
        try {
            cleanupTeamWorktrees(teamName, repoDir);
        }
        catch { /* ignore */ }
        rmSync(repoDir, { recursive: true, force: true });
    });
    describe('createWorkerWorktree', () => {
        it('creates worktree at correct path', () => {
            const info = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(info.path).toContain(`.omc/team/${teamName}/worktrees/worker1`);
            expect(info.branch).toBe(`omc-team/${teamName}/worker1`);
            expect(info.workerName).toBe('worker1');
            expect(info.teamName).toBe(teamName);
            expect(existsSync(info.path)).toBe(true);
        });
        it('branch name is properly sanitized', () => {
            const info = createWorkerWorktree(teamName, 'worker-with-special', repoDir);
            expect(info.branch).toContain('omc-team/');
            expect(existsSync(info.path)).toBe(true);
        });
        it('handles recreation of stale worktree', () => {
            const info1 = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(existsSync(info1.path)).toBe(true);
            // Recreate the same worktree
            const info2 = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(existsSync(info2.path)).toBe(true);
            expect(info2.path).toBe(info1.path);
            expect(info2.created).toBe(false);
            expect(info2.reused).toBe(true);
        });
        it('rejects a stale plain directory instead of deleting files', () => {
            const stalePath = join(repoDir, '.omc', 'team', teamName, 'worktrees', 'worker-stale');
            rmSync(stalePath, { recursive: true, force: true });
            mkdirSync(stalePath, { recursive: true });
            writeFileSync(join(stalePath, 'orphan.txt'), 'orphaned state');
            expect(() => createWorkerWorktree(teamName, 'worker-stale', repoDir)).toThrow(/worktree_path_mismatch/);
            expect(existsSync(join(stalePath, 'orphan.txt'))).toBe(true);
        });
        it('plans detached worktrees under canonical native team path', () => {
            const info = ensureWorkerWorktree(teamName, 'worker-detached', repoDir, {
                mode: 'detached',
                requireCleanLeader: false,
            });
            expect(info?.path).toContain(`.omc/team/${teamName}/worktrees/worker-detached`);
            expect(info?.detached).toBe(true);
            expect(info?.created).toBe(true);
            expect(info?.reused).toBe(false);
        });
        it('ignores native .omc metadata when requiring a clean leader for multiple workers', () => {
            const first = ensureWorkerWorktree(teamName, 'worker-clean-1', repoDir, {
                mode: 'detached',
            });
            const second = ensureWorkerWorktree(teamName, 'worker-clean-2', repoDir, {
                mode: 'detached',
            });
            expect(first?.created).toBe(true);
            expect(second?.created).toBe(true);
            expect(existsSync(first.path)).toBe(true);
            expect(existsSync(second.path)).toBe(true);
        });
        it('preserves dirty existing worktrees', () => {
            const info = createWorkerWorktree(teamName, 'worker-dirty', repoDir);
            writeFileSync(join(info.path, 'dirty.txt'), 'dirty');
            expect(() => createWorkerWorktree(teamName, 'worker-dirty', repoDir)).toThrow(/worktree_dirty/);
            expect(existsSync(join(info.path, 'dirty.txt'))).toBe(true);
        });
    });
    describe('removeWorkerWorktree', () => {
        it('preserves dirty worktrees instead of force-removing them', () => {
            const info = createWorkerWorktree(teamName, 'dirty-worker', repoDir);
            writeFileSync(join(info.path, 'dirty.txt'), 'dirty');
            expect(() => removeWorkerWorktree(teamName, 'dirty-worker', repoDir)).toThrow(/worktree_dirty/);
            expect(existsSync(info.path)).toBe(true);
        });
        it('removes worktree and branch', () => {
            const info = createWorkerWorktree(teamName, 'worker1', repoDir);
            expect(existsSync(info.path)).toBe(true);
            removeWorkerWorktree(teamName, 'worker1', repoDir);
            // Worktree directory should be gone
            expect(existsSync(info.path)).toBe(false);
            // Branch should be deleted
            const branches = execFileSync('git', ['branch'], { cwd: repoDir, encoding: 'utf-8' });
            expect(branches).not.toContain('omc-team/');
        });
        it('throws and preserves metadata when git refuses to remove a registered worktree', () => {
            const workerName = 'locked-worker';
            const info = createWorkerWorktree(teamName, workerName, repoDir);
            execFileSync('git', ['worktree', 'lock', info.path], { cwd: repoDir, stdio: 'pipe' });
            expect(() => removeWorkerWorktree(teamName, workerName, repoDir)).toThrow(/worktree_remove_failed/);
            expect(existsSync(info.path)).toBe(true);
            expect(listTeamWorktrees(teamName, repoDir).map(w => w.workerName)).toContain(workerName);
            const worktreeList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' });
            expect(worktreeList).toContain(info.path);
            execFileSync('git', ['worktree', 'unlock', info.path], { cwd: repoDir, stdio: 'pipe' });
        });
        it('does not throw for non-existent worktree', () => {
            expect(() => removeWorkerWorktree(teamName, 'nonexistent', repoDir)).not.toThrow();
        });
    });
    describe('worktree root AGENTS.md lifecycle', () => {
        it('installs a managed overlay and removes it on cleanup when no root AGENTS.md existed', () => {
            rmSync(join(repoDir, 'AGENTS.md'));
            execFileSync('git', ['add', '-u', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Remove root agents'], { cwd: repoDir, stdio: 'pipe' });
            const info = createWorkerWorktree(teamName, 'worker-agents-new', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            expect(existsSync(agentsPath)).toBe(false);
            installWorktreeRootAgents(teamName, 'worker-agents-new', repoDir, info.path, 'managed overlay\n');
            expect(readFileSync(agentsPath, 'utf-8')).toBe('managed overlay\n');
            const restored = restoreWorktreeRootAgents(teamName, 'worker-agents-new', repoDir, info.path);
            expect(restored).toEqual({ restored: true });
            expect(existsSync(agentsPath)).toBe(false);
        });
        it('backs up an existing root AGENTS.md and restores it before removal', () => {
            writeFileSync(join(repoDir, 'AGENTS.md'), 'original root instructions\n');
            execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Add root agents'], { cwd: repoDir, stdio: 'pipe' });
            const info = createWorkerWorktree(teamName, 'worker-agents-existing', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            installWorktreeRootAgents(teamName, 'worker-agents-existing', repoDir, info.path, 'managed overlay\n');
            expect(readFileSync(agentsPath, 'utf-8')).toBe('managed overlay\n');
            removeWorkerWorktree(teamName, 'worker-agents-existing', repoDir);
            expect(existsSync(info.path)).toBe(false);
        });
        it('leaves the managed overlay and backup intact when other dirty edits block cleanup', () => {
            writeFileSync(join(repoDir, 'AGENTS.md'), 'original root instructions\n');
            execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Add root agents'], { cwd: repoDir, stdio: 'pipe' });
            const workerName = 'worker-agents-dirty';
            const info = createWorkerWorktree(teamName, workerName, repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            const backupPath = join(repoDir, '.omc', 'state', 'team', teamName, 'workers', workerName, 'worktree-root-agents.json');
            installWorktreeRootAgents(teamName, workerName, repoDir, info.path, 'managed overlay\n');
            writeFileSync(join(info.path, 'dirty.txt'), 'dirty');
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.preserved).toHaveLength(1);
            expect(result.preserved[0]?.reason).toMatch(/worktree_dirty/);
            expect(existsSync(info.path)).toBe(true);
            expect(readFileSync(agentsPath, 'utf-8')).toBe('managed overlay\n');
            expect(existsSync(backupPath)).toBe(true);
            expect(listTeamWorktrees(teamName, repoDir).map(w => w.workerName)).toContain(workerName);
        });
        it('restores managed AGENTS.md only after removal preflight confirms no other dirty edits', () => {
            writeFileSync(join(repoDir, 'AGENTS.md'), 'original root instructions\n');
            execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Add root agents'], { cwd: repoDir, stdio: 'pipe' });
            const workerName = 'worker-agents-clean-preflight';
            const info = createWorkerWorktree(teamName, workerName, repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            const backupPath = join(repoDir, '.omc', 'state', 'team', teamName, 'workers', workerName, 'worktree-root-agents.json');
            installWorktreeRootAgents(teamName, workerName, repoDir, info.path, 'managed overlay\n');
            expect(() => prepareWorkerWorktreeForRemoval(teamName, workerName, repoDir, info.path)).not.toThrow();
            expect(readFileSync(agentsPath, 'utf-8')).toBe('original root instructions\n');
            expect(existsSync(backupPath)).toBe(false);
        });
        it('cleans up backup metadata after a partial AGENTS.md install left original content intact', () => {
            writeFileSync(join(repoDir, 'AGENTS.md'), 'original root instructions\n');
            execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'Add root agents'], { cwd: repoDir, stdio: 'pipe' });
            const workerName = 'worker-agents-partial-install';
            const info = createWorkerWorktree(teamName, workerName, repoDir);
            const backupDir = join(repoDir, '.omc', 'state', 'team', teamName, 'workers', workerName);
            const backupPath = join(backupDir, 'worktree-root-agents.json');
            mkdirSync(backupDir, { recursive: true });
            writeFileSync(backupPath, JSON.stringify({
                worktreePath: info.path,
                hadOriginal: true,
                originalContent: 'original root instructions\n',
                installedContent: 'managed overlay\n',
                installedAt: new Date().toISOString(),
            }), 'utf-8');
            expect(readFileSync(join(info.path, 'AGENTS.md'), 'utf-8')).toBe('original root instructions\n');
            removeWorkerWorktree(teamName, workerName, repoDir);
            expect(existsSync(info.path)).toBe(false);
            expect(existsSync(backupPath)).toBe(false);
        });
        it('preserves the worktree when AGENTS.md itself was modified by the worker', () => {
            const info = createWorkerWorktree(teamName, 'worker-agents-edited', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            installWorktreeRootAgents(teamName, 'worker-agents-edited', repoDir, info.path, 'managed overlay\n');
            writeFileSync(agentsPath, 'worker edited instructions\n');
            expect(() => removeWorkerWorktree(teamName, 'worker-agents-edited', repoDir)).toThrow(/agents_dirty/);
            expect(existsSync(info.path)).toBe(true);
            expect(readFileSync(agentsPath, 'utf-8')).toBe('worker edited instructions\n');
        });
    });
    describe('listTeamWorktrees', () => {
        it('returns empty for team with no worktrees', () => {
            const list = listTeamWorktrees(teamName, repoDir);
            expect(list).toEqual([]);
        });
        it('lists created worktrees', () => {
            createWorkerWorktree(teamName, 'worker1', repoDir);
            createWorkerWorktree(teamName, 'worker2', repoDir);
            const list = listTeamWorktrees(teamName, repoDir);
            expect(list).toHaveLength(2);
            expect(list.map(w => w.workerName)).toContain('worker1');
            expect(list.map(w => w.workerName)).toContain('worker2');
        });
    });
    describe('cleanupTeamWorktrees', () => {
        it('removes all worktrees for a team', () => {
            createWorkerWorktree(teamName, 'worker1', repoDir);
            createWorkerWorktree(teamName, 'worker2', repoDir);
            expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(2);
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.preserved).toHaveLength(0);
            expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(0);
        });
        it('preserves dirty worktrees during cleanup and leaves metadata for follow-up', () => {
            const dirty = createWorkerWorktree(teamName, 'worker-dirty', repoDir);
            writeFileSync(join(dirty.path, 'dirty.txt'), 'dirty');
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.removed).toHaveLength(0);
            expect(result.preserved).toHaveLength(1);
            expect(existsSync(dirty.path)).toBe(true);
            expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(1);
        });
        it('restores a pre-existing worktree-root AGENTS.md before removing a clean worktree', () => {
            const info = createWorkerWorktree(teamName, 'worker-agents', repoDir);
            const agentsPath = join(info.path, 'AGENTS.md');
            installWorktreeRootAgents(teamName, 'worker-agents', repoDir, info.path, 'managed worker overlay');
            expect(readFileSync(agentsPath, 'utf-8')).toBe('managed worker overlay');
            restoreWorktreeRootAgents(teamName, 'worker-agents', repoDir, info.path);
            expect(readFileSync(agentsPath, 'utf-8')).toBe('original instructions');
            removeWorkerWorktree(teamName, 'worker-agents', repoDir);
            expect(existsSync(info.path)).toBe(false);
        });
        it('preserves a worktree when the managed root AGENTS.md was edited', () => {
            const info = createWorkerWorktree(teamName, 'worker-agents-dirty', repoDir);
            installWorktreeRootAgents(teamName, 'worker-agents-dirty', repoDir, info.path, 'managed worker overlay');
            writeFileSync(join(info.path, 'AGENTS.md'), 'human edits');
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.removed).toHaveLength(0);
            expect(result.preserved).toHaveLength(1);
            expect(result.preserved[0]?.reason).toContain('agents_dirty');
            expect(existsSync(info.path)).toBe(true);
            expect(readFileSync(join(info.path, 'AGENTS.md'), 'utf-8')).toBe('human edits');
        });
        it('preserves corrupt root AGENTS backup for metadata-listed workers', () => {
            const info = createWorkerWorktree(teamName, 'worker-corrupt-backup', repoDir);
            const backupDir = join(repoDir, '.omc', 'state', 'team', teamName, 'workers', 'worker-corrupt-backup');
            const backupPath = join(backupDir, 'worktree-root-agents.json');
            mkdirSync(backupDir, { recursive: true });
            writeFileSync(backupPath, '{not-json', 'utf-8');
            rmSync(info.path, { recursive: true, force: true });
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.removed).toHaveLength(0);
            expect(result.preserved).toHaveLength(1);
            expect(result.preserved[0]?.path).toBe(backupPath);
            expect(result.preserved[0]?.reason).toContain('worktree_root_agents_backup_unreadable');
            expect(existsSync(backupPath)).toBe(true);
        });
        it('preserves team state cleanup when only worktree-root AGENTS backup remains', () => {
            const backupPath = join(repoDir, '.omc', 'state', 'team', teamName, 'workers', 'worker-backup', 'worktree-root-agents.json');
            mkdirSync(join(repoDir, '.omc', 'state', 'team', teamName, 'workers', 'worker-backup'), { recursive: true });
            writeFileSync(backupPath, JSON.stringify({
                worktreePath: join(repoDir, '.omc', 'team', teamName, 'worktrees', 'worker-backup'),
                hadOriginal: true,
                originalContent: 'original',
                installedContent: 'managed',
                installedAt: new Date().toISOString(),
            }), 'utf-8');
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.removed).toHaveLength(0);
            expect(result.preserved).toHaveLength(1);
            expect(result.preserved[0]?.path).toBe(backupPath);
            expect(result.preserved[0]?.reason).toContain('orphaned_worktree_root_agents_backup');
            expect(existsSync(backupPath)).toBe(true);
        });
        it('preserves team state cleanup when worktree metadata is corrupt', () => {
            const metadataPath = join(repoDir, '.omc', 'state', 'team', teamName, 'worktrees.json');
            mkdirSync(join(repoDir, '.omc', 'state', 'team', teamName), { recursive: true });
            writeFileSync(metadataPath, '{not-json', 'utf-8');
            const result = cleanupTeamWorktrees(teamName, repoDir);
            expect(result.removed).toHaveLength(0);
            expect(result.preserved).toHaveLength(1);
            expect(result.preserved[0]?.path).toBe(metadataPath);
            expect(result.preserved[0]?.reason).toContain('worktree_metadata_unreadable');
            expect(existsSync(metadataPath)).toBe(true);
        });
    });
});
//# sourceMappingURL=git-worktree.test.js.map