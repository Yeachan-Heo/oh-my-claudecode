import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
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
} from '../worktree-paths.js';

const TEST_DIR = '/tmp/worktree-paths-test';

describe('worktree-paths', () => {
  beforeEach(() => {
    clearWorktreeCache();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
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
});
