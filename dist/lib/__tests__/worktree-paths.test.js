import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'fs';
import { execSync } from 'child_process';
import { join, basename, resolve } from 'path';
import { tmpdir } from 'os';
import { validatePath, resolveOmcPath, resolveStatePath, ensureOmcDir, getWorktreeNotepadPath, getWorktreeProjectMemoryPath, getOmcRoot, resolvePlanPath, resolveResearchPath, resolveLogsPath, resolveWisdomPath, isPathUnderOmc, ensureAllOmcDirs, clearWorktreeCache, getProcessSessionId, resetProcessSessionId, validateSessionId, resolveToWorktreeRoot, validateWorkingDirectory, validateWorkingDirectoryOrLinkedWorktree, getWorktreeRoot, getProjectIdentifier, clearDualDirWarnings, findWorkspaceRoot, readWorkspaceMarkerConfig, warnSiblingRetrofit, clearSiblingRetrofitWarnings, resolveSessionStatePaths, isLegacyStateMigrationEnabled, } from '../worktree-paths.js';
// Check once at module load whether symlinks can be created (needs admin / Developer Mode on Windows)
let canSymlink = false;
try {
    const probe = join(tmpdir(), `omc-symlink-probe-${process.pid}`);
    const probeTarget = join(tmpdir(), `omc-symlink-target-${process.pid}`);
    mkdirSync(probeTarget, { recursive: true });
    symlinkSync(probeTarget, probe, 'dir');
    rmSync(probe);
    rmSync(probeTarget, { recursive: true, force: true });
    canSymlink = true;
}
catch {
    canSymlink = false;
}
function canonicalTestPath(path) {
    let canonical = path;
    try {
        canonical = realpathSync.native(path);
    }
    catch {
        try {
            canonical = realpathSync(path);
        }
        catch {
            // Keep the original path for the assertion failure message.
        }
    }
    const slashNormalized = canonical.replace(/\\/g, '/');
    return process.platform === 'win32' ? slashNormalized.toLowerCase() : slashNormalized;
}
const TEST_DIR = join(tmpdir(), 'worktree-paths-test');
describe('worktree-paths', () => {
    beforeEach(() => {
        clearWorktreeCache();
        clearDualDirWarnings();
        mkdirSync(TEST_DIR, { recursive: true });
    });
    afterEach(() => {
        rmSync(TEST_DIR, { recursive: true, force: true });
        delete process.env.OMC_STATE_DIR;
    });
    describe('validatePath', () => {
        it('should reject path traversal attempts', () => {
            expect(() => validatePath('../foo')).toThrow('path traversal');
            expect(() => validatePath('foo/../bar')).toThrow('path traversal');
            expect(() => validatePath('../../etc/passwd')).toThrow('path traversal');
        });
        it('should reject absolute paths', () => {
            expect(() => validatePath('/etc/passwd')).toThrow('absolute paths');
            expect(() => validatePath('~/secret')).toThrow('absolute paths');
        });
        it('should allow valid relative paths', () => {
            expect(() => validatePath('state/ralph.json')).not.toThrow();
            expect(() => validatePath('notepad.md')).not.toThrow();
            expect(() => validatePath('plans/my-plan.md')).not.toThrow();
        });
    });
    describe('resolveOmcPath', () => {
        it('should resolve paths under .omc directory', () => {
            const result = resolveOmcPath('state/ralph.json', TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'state', 'ralph.json'));
        });
        it('should reject paths that escape .omc boundary', () => {
            expect(() => resolveOmcPath('../secret.txt', TEST_DIR)).toThrow('path traversal');
        });
    });
    describe('resolveStatePath', () => {
        it('should resolve state file paths with -state suffix', () => {
            const result = resolveStatePath('ralph', TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'));
        });
        it('should handle input already having -state suffix', () => {
            const result = resolveStatePath('ultrawork-state', TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json'));
        });
        it('should resolve swarm as regular JSON path after #1131 removal', () => {
            // swarm SQLite special-casing removed in #1131
            const result = resolveStatePath('swarm', TEST_DIR);
            expect(result).toContain('swarm-state.json');
        });
    });
    describe('ensureOmcDir', () => {
        it('should create directories under .omc', () => {
            const result = ensureOmcDir('state', TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'state'));
            expect(existsSync(result)).toBe(true);
        });
    });
    describe('helper functions', () => {
        it('getWorktreeNotepadPath returns correct path', () => {
            const result = getWorktreeNotepadPath(TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'notepad.md'));
        });
        it('getWorktreeProjectMemoryPath returns correct path', () => {
            const result = getWorktreeProjectMemoryPath(TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'project-memory.json'));
        });
        it('getOmcRoot returns correct path', () => {
            const result = getOmcRoot(TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc'));
        });
        it('resolvePlanPath returns correct path', () => {
            const result = resolvePlanPath('my-feature', TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'plans', 'my-feature.md'));
        });
        it('resolveResearchPath returns correct path', () => {
            const result = resolveResearchPath('api-research', TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'research', 'api-research'));
        });
        it('resolveLogsPath returns correct path', () => {
            const result = resolveLogsPath(TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'logs'));
        });
        it('resolveWisdomPath returns correct path', () => {
            const result = resolveWisdomPath('my-plan', TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc', 'notepads', 'my-plan'));
        });
    });
    describe('isPathUnderOmc', () => {
        it('should return true for paths under .omc', () => {
            expect(isPathUnderOmc(join(TEST_DIR, '.omc', 'state', 'ralph.json'), TEST_DIR)).toBe(true);
            expect(isPathUnderOmc(join(TEST_DIR, '.omc'), TEST_DIR)).toBe(true);
        });
        it('should return false for paths outside .omc', () => {
            expect(isPathUnderOmc(join(TEST_DIR, 'src', 'file.ts'), TEST_DIR)).toBe(false);
            expect(isPathUnderOmc('/etc/passwd', TEST_DIR)).toBe(false);
        });
    });
    describe('ensureAllOmcDirs', () => {
        it('should create all standard .omc subdirectories', () => {
            ensureAllOmcDirs(TEST_DIR);
            expect(existsSync(join(TEST_DIR, '.omc'))).toBe(true);
            expect(existsSync(join(TEST_DIR, '.omc', 'state'))).toBe(true);
            expect(existsSync(join(TEST_DIR, '.omc', 'plans'))).toBe(true);
            expect(existsSync(join(TEST_DIR, '.omc', 'research'))).toBe(true);
            expect(existsSync(join(TEST_DIR, '.omc', 'logs'))).toBe(true);
            expect(existsSync(join(TEST_DIR, '.omc', 'notepads'))).toBe(true);
            expect(existsSync(join(TEST_DIR, '.omc', 'drafts'))).toBe(true);
        });
    });
    describe('resolveToWorktreeRoot', () => {
        it('should return process.cwd()-based root when no directory provided', () => {
            const result = resolveToWorktreeRoot();
            // We are inside a git repo, so it should return a real root
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
        });
        it('should resolve a subdirectory to its git worktree root', () => {
            // Use the current repo - create a subdir and verify it resolves to root
            const root = getWorktreeRoot(process.cwd());
            if (!root)
                return; // skip if not in a git repo
            const subdir = join(root, 'src');
            const result = resolveToWorktreeRoot(subdir);
            expect(result).toBe(root);
        });
        it('should fall back and log for non-git directories', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const nonGitDir = mkdtempSync(join(tmpdir(), 'worktree-paths-nongit-'));
            const result = resolveToWorktreeRoot(nonGitDir);
            // non-git directory should fall back to process.cwd root
            const expectedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
            expect(result).toBe(expectedRoot);
            expect(errorSpy).toHaveBeenCalledWith('[worktree] non-git directory provided, falling back to process root', { directory: nonGitDir });
            errorSpy.mockRestore();
            rmSync(nonGitDir, { recursive: true, force: true });
        });
        it('should handle bare repositories by falling back and logging', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const bareRepoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-bare-'));
            execSync('git init --bare', { cwd: bareRepoDir, stdio: 'pipe' });
            const result = resolveToWorktreeRoot(bareRepoDir);
            const expectedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
            expect(result).toBe(expectedRoot);
            expect(errorSpy).toHaveBeenCalledWith('[worktree] non-git directory provided, falling back to process root', { directory: bareRepoDir });
            errorSpy.mockRestore();
            rmSync(bareRepoDir, { recursive: true, force: true });
        });
    });
    describe('validateWorkingDirectory (#576)', () => {
        it('should return worktree root even when workingDirectory is a subdirectory', () => {
            // This is the core #576 fix: a subdirectory must never be returned
            const root = getWorktreeRoot(process.cwd());
            if (!root)
                return; // skip if not in a git repo
            const subdir = join(root, 'src');
            const result = validateWorkingDirectory(subdir);
            expect(result).toBe(root);
        });
        it('should return trusted root when no workingDirectory provided', () => {
            const root = getWorktreeRoot(process.cwd()) || process.cwd();
            const result = validateWorkingDirectory();
            expect(result).toBe(root);
        });
        it('should throw for directories outside the trusted root', () => {
            // tmpdir() is outside any repo worktree root and exists on every platform
            // (avoids '/etc' which is Linux-only and triggers ENOENT on Windows).
            expect(() => validateWorkingDirectory(tmpdir())).toThrow('outside the trusted worktree root');
        });
        it('should reject a workingDirectory that resolves to a different git root', () => {
            const nestedRepoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-nested-'));
            execSync('git init', { cwd: nestedRepoDir, stdio: 'pipe' });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const result = validateWorkingDirectory(nestedRepoDir);
            const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
            expect(result).toBe(trustedRoot);
            expect(errorSpy).toHaveBeenCalledWith('[worktree] workingDirectory resolved to different git worktree root, using trusted root', expect.objectContaining({
                workingDirectory: nestedRepoDir,
                providedRoot: expect.any(String),
                trustedRoot: expect.any(String),
            }));
            errorSpy.mockRestore();
            rmSync(nestedRepoDir, { recursive: true, force: true });
        });
        it('uses the submodule git top-level as the trusted validation boundary', () => {
            const parentDir = mkdtempSync(join(tmpdir(), 'worktree-paths-validator-parent-'));
            const subDir = mkdtempSync(join(tmpdir(), 'worktree-paths-validator-child-'));
            const originalCwd = process.cwd();
            try {
                execSync('git init', { cwd: subDir, stdio: 'pipe' });
                execSync('git commit --allow-empty -m "sub init"', {
                    cwd: subDir,
                    stdio: 'pipe',
                    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
                });
                execSync('git init', { cwd: parentDir, stdio: 'pipe' });
                execSync('git commit --allow-empty -m "parent init"', {
                    cwd: parentDir,
                    stdio: 'pipe',
                    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
                });
                execSync(`git -c protocol.file.allow=always submodule add "${subDir}" mysub`, {
                    cwd: parentDir,
                    stdio: 'pipe',
                });
                const submodulePath = join(parentDir, 'mysub');
                clearWorktreeCache();
                process.chdir(submodulePath);
                const expectedSubmoduleRoot = canonicalTestPath(submodulePath);
                const parentRoot = canonicalTestPath(parentDir);
                const defaultRoot = canonicalTestPath(validateWorkingDirectory());
                const explicitParentRoot = canonicalTestPath(validateWorkingDirectory(parentDir));
                const linkedParentRoot = canonicalTestPath(validateWorkingDirectoryOrLinkedWorktree(parentDir));
                expect(defaultRoot).toBe(expectedSubmoduleRoot);
                expect(explicitParentRoot).toBe(expectedSubmoduleRoot);
                expect(linkedParentRoot).toBe(expectedSubmoduleRoot);
                expect(defaultRoot).not.toBe(parentRoot);
                expect(explicitParentRoot).not.toBe(parentRoot);
                expect(linkedParentRoot).not.toBe(parentRoot);
            }
            finally {
                process.chdir(originalCwd);
                clearWorktreeCache();
                rmSync(parentDir, { recursive: true, force: true });
                rmSync(subDir, { recursive: true, force: true });
            }
        });
    });
    describe('getProcessSessionId (Issue #456)', () => {
        afterEach(() => {
            resetProcessSessionId();
        });
        it('should return a string matching pid-{PID}-{timestamp} format', () => {
            const sessionId = getProcessSessionId();
            expect(sessionId).toMatch(/^pid-\d+-\d+$/);
        });
        it('should include the current process PID', () => {
            const sessionId = getProcessSessionId();
            expect(sessionId).toContain(`pid-${process.pid}-`);
        });
        it('should return the same value on repeated calls (stable)', () => {
            const id1 = getProcessSessionId();
            const id2 = getProcessSessionId();
            const id3 = getProcessSessionId();
            expect(id1).toBe(id2);
            expect(id2).toBe(id3);
        });
        it('should pass session ID validation', () => {
            const sessionId = getProcessSessionId();
            expect(() => validateSessionId(sessionId)).not.toThrow();
        });
        it('should generate a new ID after reset', () => {
            const _id1 = getProcessSessionId();
            resetProcessSessionId();
            const id2 = getProcessSessionId();
            // IDs should differ (different timestamp)
            // In rare cases they could match if called in the same millisecond,
            // but the PID portion will be the same so we just check they're strings
            expect(typeof id2).toBe('string');
            expect(id2).toMatch(/^pid-\d+-\d+$/);
        });
    });
    // ==========================================================================
    // OMC_STATE_DIR TESTS (Issue #1014)
    // ==========================================================================
    describe('getProjectIdentifier', () => {
        it('should return a string with dirName-hash format', () => {
            const id = getProjectIdentifier(TEST_DIR);
            // Format: {dirName}-{16-char hex hash}
            expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
        });
        it('should include the directory basename in the identifier', () => {
            const id = getProjectIdentifier(TEST_DIR);
            expect(id).toContain('worktree-paths-test-');
        });
        it('should return stable results for the same input', () => {
            const id1 = getProjectIdentifier(TEST_DIR);
            const id2 = getProjectIdentifier(TEST_DIR);
            expect(id1).toBe(id2);
        });
        it('should return different results for different directories', () => {
            const dir2 = mkdtempSync(join(tmpdir(), 'worktree-paths-other-'));
            try {
                const id1 = getProjectIdentifier(TEST_DIR);
                const id2 = getProjectIdentifier(dir2);
                expect(id1).not.toBe(id2);
            }
            finally {
                rmSync(dir2, { recursive: true, force: true });
            }
        });
        it('should use git remote URL when available (stable across worktrees)', () => {
            // Create a git repo with a remote
            const repoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-remote-'));
            try {
                execSync('git init', { cwd: repoDir, stdio: 'pipe' });
                execSync('git remote add origin https://github.com/test/my-repo.git', {
                    cwd: repoDir,
                    stdio: 'pipe',
                });
                clearWorktreeCache();
                const id = getProjectIdentifier(repoDir);
                expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
                // Create a second repo with the same remote — should produce the same hash
                const repoDir2 = mkdtempSync(join(tmpdir(), 'worktree-paths-remote2-'));
                try {
                    execSync('git init', { cwd: repoDir2, stdio: 'pipe' });
                    execSync('git remote add origin https://github.com/test/my-repo.git', {
                        cwd: repoDir2,
                        stdio: 'pipe',
                    });
                    clearWorktreeCache();
                    const id2 = getProjectIdentifier(repoDir2);
                    // Same remote URL → same hash suffix
                    const hash1 = id.split('-').pop();
                    const hash2 = id2.split('-').pop();
                    expect(hash1).toBe(hash2);
                }
                finally {
                    rmSync(repoDir2, { recursive: true, force: true });
                }
            }
            finally {
                rmSync(repoDir, { recursive: true, force: true });
            }
        });
        it('should fall back to path hash for repos without remotes', () => {
            const repoDir = mkdtempSync(join(tmpdir(), 'worktree-paths-noremote-'));
            try {
                execSync('git init', { cwd: repoDir, stdio: 'pipe' });
                clearWorktreeCache();
                const id = getProjectIdentifier(repoDir);
                expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
            }
            finally {
                rmSync(repoDir, { recursive: true, force: true });
            }
        });
        it('should sanitize special characters in directory names', () => {
            const specialDir = join(tmpdir(), 'worktree paths test!@#');
            mkdirSync(specialDir, { recursive: true });
            try {
                const id = getProjectIdentifier(specialDir);
                // Special chars should be replaced with underscores
                expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
                expect(id).not.toContain(' ');
                expect(id).not.toContain('!');
                expect(id).not.toContain('@');
                expect(id).not.toContain('#');
            }
            finally {
                rmSync(specialDir, { recursive: true, force: true });
            }
        });
        it('should produce identical identifiers for linked worktrees of the same repo', () => {
            const primaryDir = mkdtempSync(join(tmpdir(), 'worktree-paths-primary-'));
            const worktreeDir = `${primaryDir}-linked`;
            try {
                // Set up a primary repo with a commit so worktree creation works
                execSync('git init', { cwd: primaryDir, stdio: 'pipe' });
                execSync('git remote add origin https://github.com/test/worktree-id-test.git', {
                    cwd: primaryDir,
                    stdio: 'pipe',
                });
                execSync('git commit --allow-empty -m "init"', {
                    cwd: primaryDir,
                    stdio: 'pipe',
                    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
                });
                // Create a linked worktree (sibling directory, different basename)
                execSync(`git worktree add "${worktreeDir}" -b linked-branch`, {
                    cwd: primaryDir,
                    stdio: 'pipe',
                });
                clearWorktreeCache();
                const primaryId = getProjectIdentifier(primaryDir);
                const worktreeId = getProjectIdentifier(worktreeDir);
                // Both should produce the same identifier — same repo, same remote
                expect(primaryId).toBe(worktreeId);
            }
            finally {
                try {
                    execSync(`git worktree remove "${worktreeDir}" --force`, {
                        cwd: primaryDir,
                        stdio: 'pipe',
                    });
                }
                catch { /* may not exist */ }
                rmSync(primaryDir, { recursive: true, force: true });
                rmSync(worktreeDir, { recursive: true, force: true });
            }
        });
        it('should not change identifier for submodules (avoid .git/modules resolution)', () => {
            const parentDir = mkdtempSync(join(tmpdir(), 'worktree-paths-submod-parent-'));
            const subDir = mkdtempSync(join(tmpdir(), 'worktree-paths-submod-child-'));
            try {
                // Create a repo to use as the submodule source
                execSync('git init', { cwd: subDir, stdio: 'pipe' });
                execSync('git commit --allow-empty -m "sub init"', {
                    cwd: subDir,
                    stdio: 'pipe',
                    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
                });
                // Create the parent repo and add the submodule
                execSync('git init', { cwd: parentDir, stdio: 'pipe' });
                execSync('git commit --allow-empty -m "init"', {
                    cwd: parentDir,
                    stdio: 'pipe',
                    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
                });
                execSync(`git -c protocol.file.allow=always submodule add "${subDir}" mysub`, {
                    cwd: parentDir,
                    stdio: 'pipe',
                });
                clearWorktreeCache();
                const submodulePath = `${parentDir}/mysub`;
                const id = getProjectIdentifier(submodulePath);
                // The identifier should use the submodule's own basename, not the
                // parent's .git/modules directory
                expect(id).toContain('mysub-');
                expect(id).not.toContain('modules');
            }
            finally {
                rmSync(parentDir, { recursive: true, force: true });
                rmSync(subDir, { recursive: true, force: true });
            }
        });
        it('should not change identifier for bare repos (avoid dirname going to parent)', () => {
            const parentDir = mkdtempSync(join(tmpdir(), 'worktree-paths-bare-parent-'));
            const bareDir = `${parentDir}/my-bare-repo.git`;
            try {
                execSync(`git init --bare "${bareDir}"`, { stdio: 'pipe' });
                clearWorktreeCache();
                const id = getProjectIdentifier(bareDir);
                // Should use the bare repo's own name, not the parent directory
                expect(id).toContain('my-bare-repo');
                expect(id).not.toContain(basename(parentDir));
            }
            finally {
                rmSync(parentDir, { recursive: true, force: true });
            }
        });
    });
    describe('getOmcRoot with OMC_STATE_DIR (Issue #1014)', () => {
        it('should return default .omc path when OMC_STATE_DIR is not set', () => {
            delete process.env.OMC_STATE_DIR;
            const result = getOmcRoot(TEST_DIR);
            expect(result).toBe(join(TEST_DIR, '.omc'));
        });
        it('should return centralized path when OMC_STATE_DIR is set', () => {
            const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
            try {
                process.env.OMC_STATE_DIR = stateDir;
                const result = getOmcRoot(TEST_DIR);
                const projectId = getProjectIdentifier(TEST_DIR);
                expect(result).toBe(join(stateDir, projectId));
                expect(result).not.toContain('.omc');
            }
            finally {
                rmSync(stateDir, { recursive: true, force: true });
            }
        });
        it('should log warning when both legacy and centralized dirs exist', () => {
            const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                process.env.OMC_STATE_DIR = stateDir;
                const projectId = getProjectIdentifier(TEST_DIR);
                // Create both directories
                mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
                mkdirSync(join(stateDir, projectId), { recursive: true });
                clearDualDirWarnings();
                getOmcRoot(TEST_DIR);
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Both legacy state dir'));
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Using centralized dir'));
            }
            finally {
                warnSpy.mockRestore();
                rmSync(stateDir, { recursive: true, force: true });
            }
        });
        it('should not log warning when only centralized dir exists', () => {
            const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                process.env.OMC_STATE_DIR = stateDir;
                const projectId = getProjectIdentifier(TEST_DIR);
                // Create only centralized dir (no legacy .omc/)
                mkdirSync(join(stateDir, projectId), { recursive: true });
                clearDualDirWarnings();
                getOmcRoot(TEST_DIR);
                expect(warnSpy).not.toHaveBeenCalled();
            }
            finally {
                warnSpy.mockRestore();
                rmSync(stateDir, { recursive: true, force: true });
            }
        });
        it('should only log dual-dir warning once per path pair', () => {
            const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-'));
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                process.env.OMC_STATE_DIR = stateDir;
                const projectId = getProjectIdentifier(TEST_DIR);
                mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
                mkdirSync(join(stateDir, projectId), { recursive: true });
                clearDualDirWarnings();
                getOmcRoot(TEST_DIR);
                getOmcRoot(TEST_DIR);
                getOmcRoot(TEST_DIR);
                // Should only warn once despite 3 calls
                expect(warnSpy).toHaveBeenCalledTimes(1);
            }
            finally {
                warnSpy.mockRestore();
                rmSync(stateDir, { recursive: true, force: true });
            }
        });
    });
    describe('path functions with OMC_STATE_DIR', () => {
        let stateDir;
        beforeEach(() => {
            stateDir = mkdtempSync(join(tmpdir(), 'omc-state-dir-paths-'));
            process.env.OMC_STATE_DIR = stateDir;
        });
        afterEach(() => {
            delete process.env.OMC_STATE_DIR;
            rmSync(stateDir, { recursive: true, force: true });
        });
        it('resolveOmcPath should resolve under centralized dir', () => {
            const result = resolveOmcPath('state/ralph.json', TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'state', 'ralph.json'));
        });
        it('resolveStatePath should resolve under centralized dir', () => {
            const result = resolveStatePath('ralph', TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'state', 'ralph-state.json'));
        });
        it('getWorktreeNotepadPath should resolve under centralized dir', () => {
            const result = getWorktreeNotepadPath(TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'notepad.md'));
        });
        it('getWorktreeProjectMemoryPath should resolve under centralized dir', () => {
            const result = getWorktreeProjectMemoryPath(TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'project-memory.json'));
        });
        it('resolvePlanPath should resolve under centralized dir', () => {
            const result = resolvePlanPath('my-feature', TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'plans', 'my-feature.md'));
        });
        it('resolveResearchPath should resolve under centralized dir', () => {
            const result = resolveResearchPath('api-research', TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'research', 'api-research'));
        });
        it('resolveLogsPath should resolve under centralized dir', () => {
            const result = resolveLogsPath(TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'logs'));
        });
        it('resolveWisdomPath should resolve under centralized dir', () => {
            const result = resolveWisdomPath('my-plan', TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'notepads', 'my-plan'));
        });
        it('isPathUnderOmc should check against centralized dir', () => {
            const projectId = getProjectIdentifier(TEST_DIR);
            const centralPath = join(stateDir, projectId, 'state', 'ralph.json');
            expect(isPathUnderOmc(centralPath, TEST_DIR)).toBe(true);
            // Legacy path should NOT be under omc when centralized
            expect(isPathUnderOmc(join(TEST_DIR, '.omc', 'state', 'ralph.json'), TEST_DIR)).toBe(false);
        });
        it('ensureAllOmcDirs should create dirs under centralized path', () => {
            ensureAllOmcDirs(TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            const centralRoot = join(stateDir, projectId);
            expect(existsSync(centralRoot)).toBe(true);
            expect(existsSync(join(centralRoot, 'state'))).toBe(true);
            expect(existsSync(join(centralRoot, 'plans'))).toBe(true);
            expect(existsSync(join(centralRoot, 'research'))).toBe(true);
            expect(existsSync(join(centralRoot, 'logs'))).toBe(true);
            expect(existsSync(join(centralRoot, 'notepads'))).toBe(true);
            expect(existsSync(join(centralRoot, 'drafts'))).toBe(true);
            // Legacy .omc/ should NOT be created
            expect(existsSync(join(TEST_DIR, '.omc'))).toBe(false);
        });
        it('ensureOmcDir should create dir under centralized path', () => {
            const result = ensureOmcDir('state', TEST_DIR);
            const projectId = getProjectIdentifier(TEST_DIR);
            expect(result).toBe(join(stateDir, projectId, 'state'));
            expect(existsSync(result)).toBe(true);
        });
    });
    describe('workspace marker (.omc-workspace)', () => {
        // Use resolve() so expectations match getOmcRoot's internally-resolved path
        // (relevant on Windows where /tmp/... is non-absolute until resolved).
        let workspaceDir;
        let subrepoDir;
        beforeEach(() => {
            clearWorktreeCache();
            workspaceDir = resolve(mkdtempSync(join(TEST_DIR, 'workspace-')));
            subrepoDir = join(workspaceDir, 'api');
            mkdirSync(subrepoDir, { recursive: true });
        });
        it('getOmcRoot ignores marker when absent (regression: monorepo flow unchanged)', () => {
            const result = getOmcRoot(workspaceDir);
            expect(result).toBe(join(workspaceDir, '.omc'));
        });
        it('getOmcRoot anchors to marker dir when marker exists in cwd', () => {
            const fs = require('node:fs');
            fs.writeFileSync(join(workspaceDir, '.omc-workspace'), '');
            clearWorktreeCache();
            const result = getOmcRoot(workspaceDir);
            expect(result).toBe(join(workspaceDir, '.omc'));
        });
        it('getOmcRoot walks up from subdir to find marker', () => {
            const fs = require('node:fs');
            fs.writeFileSync(join(workspaceDir, '.omc-workspace'), '');
            clearWorktreeCache();
            const result = getOmcRoot(subrepoDir);
            expect(result).toBe(join(workspaceDir, '.omc'));
        });
        it('getOmcRoot prefers marker over a sub-git-repo root', () => {
            const fs = require('node:fs');
            fs.writeFileSync(join(workspaceDir, '.omc-workspace'), '');
            try {
                execSync('git init -q', { cwd: subrepoDir, stdio: 'ignore' });
            }
            catch {
                return; // git unavailable — skip
            }
            clearWorktreeCache();
            const result = getOmcRoot(subrepoDir);
            expect(result).toBe(join(workspaceDir, '.omc'));
        });
        it('getProjectIdentifier honors explicit id from marker', () => {
            const fs = require('node:fs');
            fs.writeFileSync(join(workspaceDir, '.omc-workspace'), JSON.stringify({ id: 'bidchex' }));
            clearWorktreeCache();
            const id = getProjectIdentifier(subrepoDir);
            expect(id).toMatch(/^bidchex-[a-f0-9]{16}$/);
        });
        it('getProjectIdentifier derives stable id from workspace path when marker has no id', () => {
            const fs = require('node:fs');
            fs.writeFileSync(join(workspaceDir, '.omc-workspace'), '{}');
            clearWorktreeCache();
            const id1 = getProjectIdentifier(subrepoDir);
            clearWorktreeCache();
            const id2 = getProjectIdentifier(workspaceDir);
            expect(id1).toBe(id2);
            expect(id1.startsWith(basename(workspaceDir))).toBe(true);
        });
    });
    // ==========================================================================
    // E.1 — Workspace marker edge cases (Wave E)
    // ==========================================================================
    describe('workspace marker edge cases', () => {
        let rootA;
        beforeEach(() => {
            clearWorktreeCache();
            rootA = resolve(mkdtempSync(join(tmpdir(), 'omc-ws-edge-A-')));
        });
        afterEach(() => {
            rmSync(rootA, { recursive: true, force: true });
        });
        it('nested markers: inner workspace wins over outer', () => {
            // Structure: rootA/.omc-workspace  AND  rootA/B/.omc-workspace
            // findWorkspaceRoot from rootA/B/sub/ should return rootA/B (inner wins)
            const innerB = join(rootA, 'B');
            const sub = join(innerB, 'sub');
            mkdirSync(sub, { recursive: true });
            writeFileSync(join(rootA, '.omc-workspace'), '');
            writeFileSync(join(innerB, '.omc-workspace'), '');
            clearWorktreeCache();
            const found = findWorkspaceRoot(sub);
            expect(found).toBe(innerB);
        });
        it('OMC_STATE_DIR overrides workspace marker: getOmcRoot returns centralized path', () => {
            const stateDir = mkdtempSync(join(tmpdir(), 'omc-state-override-'));
            try {
                // Drop a workspace marker — without OMC_STATE_DIR it would steer to rootA/.omc
                writeFileSync(join(rootA, '.omc-workspace'), '');
                clearWorktreeCache();
                process.env.OMC_STATE_DIR = stateDir;
                const result = getOmcRoot(rootA);
                // Must use centralized path, not the workspace-anchored .omc
                expect(result).not.toBe(join(rootA, '.omc'));
                expect(result.startsWith(stateDir)).toBe(true);
            }
            finally {
                delete process.env.OMC_STATE_DIR;
                rmSync(stateDir, { recursive: true, force: true });
            }
        });
        it('invalid JSON in marker: readWorkspaceMarkerConfig returns {} gracefully', () => {
            writeFileSync(join(rootA, '.omc-workspace'), '{ not valid json !!!');
            expect(() => readWorkspaceMarkerConfig(rootA)).not.toThrow();
            const cfg = readWorkspaceMarkerConfig(rootA);
            expect(cfg).toEqual({});
        });
        it('special chars in marker id are sanitized', () => {
            writeFileSync(join(rootA, '.omc-workspace'), JSON.stringify({ id: 'bidchex@v2/main' }));
            clearWorktreeCache();
            const id = getProjectIdentifier(rootA);
            // Special chars replaced with underscores — no @, /, or other non-alnum chars
            expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
            expect(id).not.toContain('@');
            expect(id).not.toContain('/');
        });
        it.skipIf(process.platform === 'win32' && !canSymlink)('symlinked workspace root: findWorkspaceRoot resolves through symlink', () => {
            const realDir = mkdtempSync(join(tmpdir(), 'omc-ws-real-'));
            const linkDir = join(tmpdir(), `omc-ws-link-${process.pid}`);
            try {
                writeFileSync(join(realDir, '.omc-workspace'), '');
                symlinkSync(realDir, linkDir, 'dir');
                clearWorktreeCache();
                // Walk from the symlink — should still find the marker
                const found = findWorkspaceRoot(linkDir);
                expect(found).not.toBeNull();
            }
            finally {
                try {
                    rmSync(linkDir);
                }
                catch { /* ignore */ }
                rmSync(realDir, { recursive: true, force: true });
            }
        });
    });
    // ==========================================================================
    // warnSiblingRetrofit + clearSiblingRetrofitWarnings
    // ==========================================================================
    describe('warnSiblingRetrofit + clearSiblingRetrofitWarnings', () => {
        let anchorDir;
        let stderrSpy;
        beforeEach(() => {
            anchorDir = resolve(mkdtempSync(join(tmpdir(), 'omc-sibling-anchor-')));
            stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            clearSiblingRetrofitWarnings();
        });
        afterEach(() => {
            stderrSpy.mockRestore();
            clearSiblingRetrofitWarnings();
            rmSync(anchorDir, { recursive: true, force: true });
        });
        it('warns once when siblings have pre-existing .omc/state dirs', () => {
            const siblingA = join(anchorDir, 'repoA');
            const siblingB = join(anchorDir, 'repoB');
            mkdirSync(join(siblingA, '.omc', 'state'), { recursive: true });
            mkdirSync(join(siblingB, '.omc', 'state'), { recursive: true });
            warnSiblingRetrofit(anchorDir);
            expect(stderrSpy).toHaveBeenCalledTimes(1);
            const written = String(stderrSpy.mock.calls[0][0]);
            expect(written).toContain('workspace-retrofit warning');
            expect(written).toContain(join(siblingA, '.omc'));
            expect(written).toContain(join(siblingB, '.omc'));
        });
        it('does not warn when no sibling has .omc/state', () => {
            const siblingA = join(anchorDir, 'repoA');
            mkdirSync(siblingA, { recursive: true });
            warnSiblingRetrofit(anchorDir);
            expect(stderrSpy).not.toHaveBeenCalled();
        });
        it('second call with same sessionId stays silent (in-memory dedupe)', () => {
            const siblingA = join(anchorDir, 'repoA');
            mkdirSync(join(siblingA, '.omc', 'state'), { recursive: true });
            warnSiblingRetrofit(anchorDir, 'test-session-1');
            warnSiblingRetrofit(anchorDir, 'test-session-1');
            expect(stderrSpy).toHaveBeenCalledTimes(1);
        });
        it('second call with same sessionId stays silent via disk marker', () => {
            const siblingA = join(anchorDir, 'repoA');
            mkdirSync(join(siblingA, '.omc', 'state'), { recursive: true });
            const sessionId = 'disk-dedupe-session';
            warnSiblingRetrofit(anchorDir, sessionId);
            // Reset in-memory set but keep disk marker
            clearSiblingRetrofitWarnings();
            warnSiblingRetrofit(anchorDir, sessionId);
            // Only warned once — disk marker stopped second call
            expect(stderrSpy).toHaveBeenCalledTimes(1);
        });
        it('disk marker is written under {anchor}/.omc/state/sibling-retrofit-warned-{sid}.json', () => {
            const siblingA = join(anchorDir, 'repoA');
            mkdirSync(join(siblingA, '.omc', 'state'), { recursive: true });
            const sessionId = 'marker-write-test';
            warnSiblingRetrofit(anchorDir, sessionId);
            const markerPath = join(anchorDir, '.omc', 'state', `sibling-retrofit-warned-${sessionId}.json`);
            expect(existsSync(markerPath)).toBe(true);
        });
        it('different sessionId re-warns after in-memory clear', () => {
            const siblingA = join(anchorDir, 'repoA');
            mkdirSync(join(siblingA, '.omc', 'state'), { recursive: true });
            warnSiblingRetrofit(anchorDir, 'session-A');
            clearSiblingRetrofitWarnings();
            warnSiblingRetrofit(anchorDir, 'session-B');
            expect(stderrSpy).toHaveBeenCalledTimes(2);
        });
        it('clearSiblingRetrofitWarnings removes disk markers and allows re-warn', () => {
            const siblingA = join(anchorDir, 'repoA');
            mkdirSync(join(siblingA, '.omc', 'state'), { recursive: true });
            const sessionId = 'clear-test-session';
            warnSiblingRetrofit(anchorDir, sessionId);
            expect(stderrSpy).toHaveBeenCalledTimes(1);
            // Clear both in-memory and disk markers
            clearSiblingRetrofitWarnings(join(anchorDir, '.omc'));
            const markerPath = join(anchorDir, '.omc', 'state', `sibling-retrofit-warned-${sessionId}.json`);
            expect(existsSync(markerPath)).toBe(false);
            // Subsequent call should warn again
            warnSiblingRetrofit(anchorDir, sessionId);
            expect(stderrSpy).toHaveBeenCalledTimes(2);
        });
    });
    // ==========================================================================
    // resolveSessionStatePaths — RUNTIME behavior
    // ==========================================================================
    describe('resolveSessionStatePaths', () => {
        let workDir;
        beforeEach(() => {
            workDir = resolve(mkdtempSync(join(tmpdir(), 'omc-ssp-')));
            clearWorktreeCache();
        });
        afterEach(() => {
            rmSync(workDir, { recursive: true, force: true });
            clearWorktreeCache();
        });
        it('no sessionId: sessionScoped is empty string, effectiveRead and effectiveWrite equal legacy', () => {
            const paths = resolveSessionStatePaths('ralph', undefined, workDir);
            expect(paths.sessionScoped).toBe('');
            const expectedLegacy = join(workDir, '.omc', 'state', 'ralph-state.json');
            expect(paths.legacy).toBe(expectedLegacy);
            expect(paths.effectiveRead).toBe(expectedLegacy);
            expect(paths.effectiveWrite).toBe(expectedLegacy);
        });
        it('with sessionId: effectiveWrite is the session-scoped path', () => {
            const sessionId = 'pid-99999-1234567890';
            const paths = resolveSessionStatePaths('ultrawork', sessionId, workDir);
            const expectedSession = join(workDir, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
            expect(paths.effectiveWrite).toBe(expectedSession);
            expect(paths.sessionScoped).toBe(expectedSession);
        });
        it('effectiveRead === legacy when session-scoped file does not exist yet', () => {
            const sessionId = 'pid-99999-1111111111';
            const paths = resolveSessionStatePaths('ralph', sessionId, workDir);
            const expectedLegacy = join(workDir, '.omc', 'state', 'ralph-state.json');
            expect(paths.effectiveRead).toBe(expectedLegacy);
        });
        it('effectiveRead === sessionScoped after session file is created', () => {
            const sessionId = 'pid-99999-2222222222';
            const sessionScoped = join(workDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
            mkdirSync(join(workDir, '.omc', 'state', 'sessions', sessionId), { recursive: true });
            writeFileSync(sessionScoped, '{}');
            const paths = resolveSessionStatePaths('ralph', sessionId, workDir);
            expect(paths.effectiveRead).toBe(sessionScoped);
        });
        it('normalizes "ralph" and "ralph-state" to same output path', () => {
            const sessionId = 'pid-99999-3333333333';
            const paths1 = resolveSessionStatePaths('ralph', sessionId, workDir);
            const paths2 = resolveSessionStatePaths('ralph-state', sessionId, workDir);
            expect(paths1.effectiveWrite).toBe(paths2.effectiveWrite);
            expect(paths1.sessionScoped).toBe(paths2.sessionScoped);
        });
        it('throws for invalid sessionId containing path traversal', () => {
            expect(() => resolveSessionStatePaths('ralph', '../x', workDir)).toThrow();
        });
    });
    // ==========================================================================
    // isLegacyStateMigrationEnabled
    // ==========================================================================
    describe('isLegacyStateMigrationEnabled', () => {
        afterEach(() => {
            delete process.env.OMC_MIGRATE_LEGACY_STATE;
        });
        it('returns true when OMC_MIGRATE_LEGACY_STATE=1', () => {
            process.env.OMC_MIGRATE_LEGACY_STATE = '1';
            expect(isLegacyStateMigrationEnabled()).toBe(true);
        });
        it('returns false when OMC_MIGRATE_LEGACY_STATE is unset', () => {
            delete process.env.OMC_MIGRATE_LEGACY_STATE;
            expect(isLegacyStateMigrationEnabled()).toBe(false);
        });
        it('returns false when OMC_MIGRATE_LEGACY_STATE is set to a non-"1" value', () => {
            process.env.OMC_MIGRATE_LEGACY_STATE = 'true';
            expect(isLegacyStateMigrationEnabled()).toBe(false);
        });
        it('returns false when OMC_MIGRATE_LEGACY_STATE is "0"', () => {
            process.env.OMC_MIGRATE_LEGACY_STATE = '0';
            expect(isLegacyStateMigrationEnabled()).toBe(false);
        });
    });
    // ==========================================================================
    // findWorkspaceRoot home-boundary regression (P2)
    // ==========================================================================
    describe('findWorkspaceRoot home-boundary', () => {
        let savedHome;
        let savedUserProfile;
        let fakeHome;
        beforeEach(() => {
            savedHome = process.env.HOME;
            savedUserProfile = process.env.USERPROFILE;
            fakeHome = resolve(mkdtempSync(join(tmpdir(), 'omc-fakehome-')));
            process.env.HOME = fakeHome;
            process.env.USERPROFILE = fakeHome;
            clearWorktreeCache();
        });
        afterEach(() => {
            if (savedHome === undefined) {
                delete process.env.HOME;
            }
            else {
                process.env.HOME = savedHome;
            }
            if (savedUserProfile === undefined) {
                delete process.env.USERPROFILE;
            }
            else {
                process.env.USERPROFILE = savedUserProfile;
            }
            clearWorktreeCache();
            rmSync(fakeHome, { recursive: true, force: true });
        });
        it('marker EXACTLY at home dir is NOT returned (null)', () => {
            writeFileSync(join(fakeHome, '.omc-workspace'), '');
            clearWorktreeCache();
            // Start from a subdir of home to trigger the walk, stopping at home itself
            const subDir = join(fakeHome, 'projects', 'myrepo');
            mkdirSync(subDir, { recursive: true });
            const result = findWorkspaceRoot(subDir);
            expect(result).toBeNull();
        });
        it('marker BELOW home IS found', () => {
            const projectDir = join(fakeHome, 'workspace');
            mkdirSync(projectDir, { recursive: true });
            writeFileSync(join(projectDir, '.omc-workspace'), '');
            clearWorktreeCache();
            const subDir = join(projectDir, 'subrepo');
            mkdirSync(subDir, { recursive: true });
            const result = findWorkspaceRoot(subDir);
            expect(result).toBe(projectDir);
        });
    });
});
//# sourceMappingURL=worktree-paths.test.js.map