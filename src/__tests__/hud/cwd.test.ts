import { describe, it, expect, vi } from 'vitest';
import { renderCwd } from '../../hud/elements/cwd.js';

// Mock os.homedir and path.basename
vi.mock('node:os', () => ({
  homedir: () => '/Users/testuser',
}));

describe('renderCwd', () => {
  describe('null/empty handling', () => {
    it('returns null for undefined cwd', () => {
      expect(renderCwd(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(renderCwd('')).toBeNull();
    });
  });

  describe('relative format (default)', () => {
    it('converts home directory path to ~-relative', () => {
      const result = renderCwd('/Users/testuser/workspace/project');
      expect(result).toContain('~/workspace/project');
    });

    it('converts home directory path to ~-relative with explicit format', () => {
      const result = renderCwd('/Users/testuser/workspace/project', 'relative');
      expect(result).toContain('~/workspace/project');
    });

    it('handles exact home directory', () => {
      const result = renderCwd('/Users/testuser', 'relative');
      expect(result).toContain('~');
    });

    it('preserves paths outside home directory', () => {
      const result = renderCwd('/tmp/some/path', 'relative');
      expect(result).toContain('/tmp/some/path');
    });
  });

  describe('absolute format', () => {
    it('returns full absolute path', () => {
      const result = renderCwd('/Users/testuser/workspace/project', 'absolute');
      expect(result).toContain('/Users/testuser/workspace/project');
    });

    it('does not replace home with ~', () => {
      const result = renderCwd('/Users/testuser/workspace/project', 'absolute');
      expect(result).not.toContain('~');
    });
  });

  describe('folder format', () => {
    it('shows parent/leaf to disambiguate common directory names', () => {
      const result = renderCwd('/Users/testuser/workspace/project', 'folder');
      expect(result).toContain('workspace/project');
    });

    it('handles nested paths', () => {
      const result = renderCwd('/a/b/c/deep/folder', 'folder');
      expect(result).toContain('deep/folder');
    });

    it('disambiguates ambiguous leaf names like src', () => {
      const resultA = renderCwd('/home/user/project-a/src', 'folder');
      const resultB = renderCwd('/home/user/project-b/src', 'folder');
      expect(resultA).toContain('project-a/src');
      expect(resultB).toContain('project-b/src');
      expect(resultA).not.toEqual(resultB);
    });

    it('handles filesystem-root paths without crashing', () => {
      const result = renderCwd('/', 'folder');
      // basename('/') === '', basename(dirname('/')) === '' — should not include a stray slash
      expect(result).not.toBeNull();
    });
  });

  describe('styling', () => {
    it('applies dim styling', () => {
      const result = renderCwd('/Users/testuser/project');
      expect(result).toContain('\x1b[2m'); // dim escape code
    });
  });
});
