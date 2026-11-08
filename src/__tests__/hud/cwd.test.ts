import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { renderCwd } from '../../hud/elements/cwd.js';

// Mock os.homedir (controllable so Windows-style homes can be exercised too).
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/Users/testuser'),
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

    it('does not collapse a sibling prefix under the home directory name', () => {
      const result = renderCwd('/Users/testuser2/workspace/project', 'relative');
      expect(result).toContain('/Users/testuser2/workspace/project');
      expect(result).not.toContain('~2');
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

  // On Windows, the cwd handed to renderCwd comes from
  // `git rev-parse --show-toplevel` (via resolveToWorktreeRoot), which emits
  // forward slashes, while homedir() emits backslashes. A raw startsWith()
  // misses, so the full absolute path leaks into the HUD instead of "~".
  describe('relative format with backslash home (Windows)', () => {
    beforeEach(() => {
      vi.mocked(homedir).mockReturnValue('C:\\Users\\testuser');
    });
    afterEach(() => {
      vi.mocked(homedir).mockReturnValue('/Users/testuser');
    });

    it('collapses a forward-slash cwd under a backslash home to ~', () => {
      const result = renderCwd('C:/Users/testuser/workspace/project', 'relative');
      expect(result).toContain('~/workspace/project');
      expect(result).not.toContain('C:');
    });

    it('collapses the exact home directory to ~', () => {
      const result = renderCwd('C:/Users/testuser', 'relative');
      expect(result).toContain('~');
      expect(result).not.toContain('C:');
    });

    it('does not collapse a sibling prefix under the Windows home directory name', () => {
      const result = renderCwd('C:/Users/testuser2/workspace/project', 'relative');
      expect(result).toContain('C:/Users/testuser2/workspace/project');
      expect(result).not.toContain('~2');
    });

    it('preserves a path outside home', () => {
      const result = renderCwd('D:/work/project', 'relative');
      expect(result).toContain('D:/work/project');
      expect(result).not.toContain('~');
    });
  });
});
