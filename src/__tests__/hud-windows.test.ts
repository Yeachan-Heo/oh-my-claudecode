import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getPluginCacheBase, getClaudeConfigDir } from '../utils/paths.js';

/**
 * HUD Windows Compatibility Tests
 *
 * These tests verify Windows compatibility fixes for HUD:
 * - File naming (omc-hud.mjs)
 * - Windows dynamic import() requires file:// URLs (pathToFileURL)
 * - Version sorting (numeric vs lexicographic)
 * - Cross-platform plugin cache path resolution (#670)
 *
 * Related: GitHub Issue #138, PR #139, PR #140, Issue #670
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..');

describe('HUD Windows Compatibility', () => {
  describe('File Naming', () => {
    it('session-start.mjs should reference omc-hud.mjs', () => {
      const sessionStartPath = join(packageRoot, 'scripts', 'session-start.mjs');
      expect(existsSync(sessionStartPath)).toBe(true);

      const content = readFileSync(sessionStartPath, 'utf-8');
      expect(content).toContain('omc-hud.mjs');
      // Note: May also contain 'omc-hud.mjs' for backward compatibility (dual naming)
    });

    it('installer should create omc-hud.mjs', () => {
      const installerPath = join(packageRoot, 'src', 'installer', 'index.ts');
      expect(existsSync(installerPath)).toBe(true);

      const content = readFileSync(installerPath, 'utf-8');
      expect(content).toContain('omc-hud.mjs');
      // Note: May also contain 'omc-hud.mjs' for legacy support
    });
  });

  describe('pathToFileURL for Dynamic Import', () => {
    it('installer HUD script should import pathToFileURL', () => {
      const installerPath = join(packageRoot, 'src', 'installer', 'index.ts');
      const content = readFileSync(installerPath, 'utf-8');

      // Should have pathToFileURL import in the generated script
      expect(content).toContain('import { pathToFileURL } from "node:url"');
    });

    it('installer HUD script should use pathToFileURL for dev path import', () => {
      const installerPath = join(packageRoot, 'src', 'installer', 'index.ts');
      const content = readFileSync(installerPath, 'utf-8');

      // Should use pathToFileURL for devPath
      expect(content).toContain('pathToFileURL(devPath).href');
    });

    it('installer HUD script should use pathToFileURL for plugin path import', () => {
      const installerPath = join(packageRoot, 'src', 'installer', 'index.ts');
      const content = readFileSync(installerPath, 'utf-8');

      // Should use pathToFileURL for pluginPath
      expect(content).toContain('pathToFileURL(pluginPath).href');
    });

    it('pathToFileURL should correctly convert Unix paths', () => {
      const unixPath = '/home/user/test.js';
      expect(pathToFileURL(unixPath).href).toBe(
        process.platform === 'win32'
          ? 'file:///C:/home/user/test.js'
          : 'file:///home/user/test.js'
      );
    });

    it('pathToFileURL should encode spaces in paths', () => {
      const spacePath = '/path/with spaces/file.js';
      expect(pathToFileURL(spacePath).href).toBe(
        process.platform === 'win32'
          ? 'file:///C:/path/with%20spaces/file.js'
          : 'file:///path/with%20spaces/file.js'
      );
    });
  });

  describe('Numeric Version Sorting', () => {
    it('installer HUD script should use numeric version sorting', () => {
      const installerPath = join(packageRoot, 'src', 'installer', 'index.ts');
      const content = readFileSync(installerPath, 'utf-8');

      // Should use localeCompare with numeric option
      expect(content).toContain('localeCompare(b, undefined, { numeric: true })');
    });

    it('numeric sort should correctly order versions', () => {
      const versions = ['3.5.0', '3.10.0', '3.9.0'];

      // Incorrect lexicographic sort
      const lexSorted = [...versions].sort().reverse();
      expect(lexSorted[0]).toBe('3.9.0'); // Wrong! 9 > 1 lexicographically

      // Correct numeric sort
      const numSorted = [...versions].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ).reverse();
      expect(numSorted[0]).toBe('3.10.0'); // Correct! 10 > 9 > 5 numerically
    });

    it('should handle single-digit and double-digit versions', () => {
      const versions = ['1.0.0', '10.0.0', '2.0.0', '9.0.0'];
      const sorted = [...versions].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ).reverse();
      expect(sorted).toEqual(['10.0.0', '9.0.0', '2.0.0', '1.0.0']);
    });

    it('should handle patch version comparison', () => {
      const versions = ['1.0.1', '1.0.10', '1.0.9', '1.0.2'];
      const sorted = [...versions].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ).reverse();
      expect(sorted).toEqual(['1.0.10', '1.0.9', '1.0.2', '1.0.1']);
    });
  });

  describe('Cross-Platform Plugin Cache Path (#670)', () => {
    it('getPluginCacheBase should return path with correct segments', () => {
      const cachePath = getPluginCacheBase();
      // Should contain the expected path segments regardless of separator
      const normalized = cachePath.replace(/\\/g, '/');
      expect(normalized).toContain('plugins/cache/omc/oh-my-claudecode');
    });

    it('getPluginCacheBase should use platform-native separators', () => {
      const cachePath = getPluginCacheBase();
      // On Windows: backslashes, on Unix: forward slashes
      expect(cachePath).toContain(`plugins${sep}cache${sep}omc${sep}oh-my-claudecode`);
    });

    it('getPluginCacheBase should be under claude config dir', () => {
      const cachePath = getPluginCacheBase();
      const configDir = getClaudeConfigDir();
      expect(cachePath.startsWith(configDir)).toBe(true);
    });

    it('plugin-setup.mjs should use pathToFileURL for dynamic imports', () => {
      const setupPath = join(packageRoot, 'scripts', 'plugin-setup.mjs');
      const content = readFileSync(setupPath, 'utf-8');

      // Should import pathToFileURL
      expect(content).toContain('import { pathToFileURL } from "node:url"');
      // Should use pathToFileURL for the dynamic import
      expect(content).toContain('pathToFileURL(pluginPath).href');
    });

    it('plugin-setup.mjs should respect CLAUDE_CONFIG_DIR for plugin cache base', () => {
      const setupPath = join(packageRoot, 'scripts', 'plugin-setup.mjs');
      const content = readFileSync(setupPath, 'utf-8');

      // Should use CLAUDE_CONFIG_DIR env var for cross-platform compat (#897)
      expect(content).toContain('process.env.CLAUDE_CONFIG_DIR');
      // Should use join() with configDir for path construction
      expect(content).toContain('join(configDir,');
    });

    it('omc-doctor skill should use cross-platform Node.js commands', () => {
      const doctorPath = join(packageRoot, 'skills', 'omc-doctor', 'SKILL.md');
      const content = readFileSync(doctorPath, 'utf-8');

      // Should NOT use ~ for plugin cache paths in bash commands
      expect(content).not.toMatch(/ls ~\/\.claude\/plugins\/cache/);
      // Should use node -e for cross-platform compatibility
      expect(content).toContain("node -e");
      // Should use path.join for constructing paths
      expect(content).toContain("p.join(d,'plugins','cache','omc','oh-my-claudecode')");
    });

    it('hud skill should use cross-platform Node.js commands for plugin detection', () => {
      const hudPath = join(packageRoot, 'skills', 'hud', 'SKILL.md');
      const content = readFileSync(hudPath, 'utf-8');

      // Step 1 and Step 2 should use node -e instead of ls/sort -V
      expect(content).not.toMatch(/ls ~\/\.claude\/plugins\/cache/);
      expect(content).not.toMatch(/sort -V/);
      // Should use node for cross-platform path resolution
      expect(content).toContain("node -e");
    });

    it('usage-api should use path.join with separate segments', () => {
      const usageApiPath = join(packageRoot, 'src', 'hud', 'usage-api.ts');
      const content = readFileSync(usageApiPath, 'utf-8');

      // Should use join() with separate segments, not forward-slash literals
      expect(content).toContain("'plugins', 'oh-my-claudecode', '.usage-cache.json'");
    });
  });
});
