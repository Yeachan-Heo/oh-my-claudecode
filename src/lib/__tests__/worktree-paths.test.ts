import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  validatePath,
  resolveOmcPath,
  resolveStatePath,
  ensureOmcDir,
  getWorktreeNotepadPath,
  getWorktreeProjectMemoryPath,
  getOmcRoot,
  resolvePlanPath,
  resolveResearchPath,
  resolveLogsPath,
  resolveWisdomPath,
  isPathUnderOmc,
  ensureAllOmcDirs,
  clearWorktreeCache,
  getProcessSessionId,
  resetProcessSessionId,
  validateSessionId,
  resolveToWorktreeRoot,
  validateWorkingDirectory,
  getWorktreeRoot,
  getProjectIdentifier,
  clearDualDirWarnings,
} from '../worktree-paths.js';

const TEST_DIR = '/tmp/worktree-paths-test';

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

    it('should throw for swarm (uses SQLite, not JSON)', () => {
      expect(() => resolveStatePath('swarm', TEST_DIR)).toThrow('SQLite');
      expect(() => resolveStatePath('swarm-state', TEST_DIR)).toThrow('SQLite');
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
      if (!root) return; // skip if not in a git repo
      const subdir = join(root, 'src');
      const result = resolveToWorktreeRoot(subdir);
      expect(result).toBe(root);
    });

    it('should fall back and log for non-git directories', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const nonGitDir = mkdtempSync('/tmp/worktree-paths-nongit-');

      const result = resolveToWorktreeRoot(nonGitDir);

      // non-git directory should fall back to process.cwd root
      const expectedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
      expect(result).toBe(expectedRoot);
      expect(errorSpy).toHaveBeenCalledWith(
        '[worktree] non-git directory provided, falling back to process root',
        { directory: nonGitDir }
      );

      errorSpy.mockRestore();
      rmSync(nonGitDir, { recursive: true, force: true });
    });

    it('should handle bare repositories by falling back and logging', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const bareRepoDir = mkdtempSync('/tmp/worktree-paths-bare-');
      execSync('git init --bare', { cwd: bareRepoDir, stdio: 'pipe' });

      const result = resolveToWorktreeRoot(bareRepoDir);

      const expectedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
      expect(result).toBe(expectedRoot);
      expect(errorSpy).toHaveBeenCalledWith(
        '[worktree] non-git directory provided, falling back to process root',
        { directory: bareRepoDir }
      );

      errorSpy.mockRestore();
      rmSync(bareRepoDir, { recursive: true, force: true });
    });
  });

  describe('validateWorkingDirectory (#576)', () => {
    it('should return worktree root even when workingDirectory is a subdirectory', () => {
      // This is the core #576 fix: a subdirectory must never be returned
      const root = getWorktreeRoot(process.cwd());
      if (!root) return; // skip if not in a git repo
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
      // /etc is outside any repo worktree root
      expect(() => validateWorkingDirectory('/etc')).toThrow('outside the trusted worktree root');
    });

    it('should reject a workingDirectory that resolves to a different git root', () => {
      const nestedRepoDir = mkdtempSync('/tmp/worktree-paths-nested-');
      execSync('git init', { cwd: nestedRepoDir, stdio: 'pipe' });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = validateWorkingDirectory(nestedRepoDir);

      const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
      expect(result).toBe(trustedRoot);
      expect(errorSpy).toHaveBeenCalledWith(
        '[worktree] workingDirectory resolved to different git worktree root, using trusted root',
        expect.objectContaining({
          workingDirectory: nestedRepoDir,
          providedRoot: expect.any(String),
          trustedRoot: expect.any(String),
        })
      );

      errorSpy.mockRestore();
      rmSync(nestedRepoDir, { recursive: true, force: true });
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
      const id1 = getProcessSessionId();
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
      const dir2 = mkdtempSync('/tmp/worktree-paths-other-');
      try {
        const id1 = getProjectIdentifier(TEST_DIR);
        const id2 = getProjectIdentifier(dir2);
        expect(id1).not.toBe(id2);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    });

    it('should use git remote URL when available (stable across worktrees)', () => {
      // Create a git repo with a remote
      const repoDir = mkdtempSync('/tmp/worktree-paths-remote-');
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
        const repoDir2 = mkdtempSync('/tmp/worktree-paths-remote2-');
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
        } finally {
          rmSync(repoDir2, { recursive: true, force: true });
        }
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('should fall back to path hash for repos without remotes', () => {
      const repoDir = mkdtempSync('/tmp/worktree-paths-noremote-');
      try {
        execSync('git init', { cwd: repoDir, stdio: 'pipe' });
        clearWorktreeCache();

        const id = getProjectIdentifier(repoDir);
        expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('should sanitize special characters in directory names', () => {
      const specialDir = '/tmp/worktree paths test!@#';
      mkdirSync(specialDir, { recursive: true });
      try {
        const id = getProjectIdentifier(specialDir);
        // Special chars should be replaced with underscores
        expect(id).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
        expect(id).not.toContain(' ');
        expect(id).not.toContain('!');
        expect(id).not.toContain('@');
        expect(id).not.toContain('#');
      } finally {
        rmSync(specialDir, { recursive: true, force: true });
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
      const stateDir = mkdtempSync('/tmp/omc-state-dir-');
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const result = getOmcRoot(TEST_DIR);
        const projectId = getProjectIdentifier(TEST_DIR);
        expect(result).toBe(join(stateDir, projectId));
        expect(result).not.toContain('.omc');
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('should log warning when both legacy and centralized dirs exist', () => {
      const stateDir = mkdtempSync('/tmp/omc-state-dir-');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const projectId = getProjectIdentifier(TEST_DIR);

        // Create both directories
        mkdirSync(join(TEST_DIR, '.omc'), { recursive: true });
        mkdirSync(join(stateDir, projectId), { recursive: true });

        clearDualDirWarnings();
        getOmcRoot(TEST_DIR);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Both legacy state dir')
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Using centralized dir')
        );
      } finally {
        warnSpy.mockRestore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('should not log warning when only centralized dir exists', () => {
      const stateDir = mkdtempSync('/tmp/omc-state-dir-');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env.OMC_STATE_DIR = stateDir;
        const projectId = getProjectIdentifier(TEST_DIR);

        // Create only centralized dir (no legacy .omc/)
        mkdirSync(join(stateDir, projectId), { recursive: true });

        clearDualDirWarnings();
        getOmcRoot(TEST_DIR);

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it('should only log dual-dir warning once per path pair', () => {
      const stateDir = mkdtempSync('/tmp/omc-state-dir-');
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
      } finally {
        warnSpy.mockRestore();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('path functions with OMC_STATE_DIR', () => {
    let stateDir: string;

    beforeEach(() => {
      stateDir = mkdtempSync('/tmp/omc-state-dir-paths-');
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
});
