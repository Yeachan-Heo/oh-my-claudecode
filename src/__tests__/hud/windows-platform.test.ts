import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..', '..');

/**
 * Windows Platform Compatibility Tests
 *
 * Verifies that HUD components work correctly on Windows by:
 * 1. Checking bridge NODE_PATH separator uses platform-aware logic
 * 2. Mocking process.platform to test Windows code paths
 * 3. Verifying ASCII fallback for emoji on Windows
 * 4. Verifying shell option for git execSync on Windows
 * 5. Verifying safe mode auto-enable on Windows
 *
 * Related: GitHub Issue #739
 */

// Helper: simulate platform comparison without triggering TS2367
// TypeScript narrows string literals, so 'darwin' === 'win32' triggers
// "This comparison appears to be unintentional". Using a function avoids this.
function isWin32(platform: string): boolean {
  return platform === 'win32';
}

function getSeparator(platform: string): string {
  return isWin32(platform) ? ';' : ':';
}

function getShellOption(platform: string): string | undefined {
  return isWin32(platform) ? 'cmd.exe' : undefined;
}

function getSafeMode(configSafeMode: boolean, platform: string): boolean {
  return configSafeMode || isWin32(platform);
}

describe('Windows HUD Platform Fixes (#739)', () => {
  // =========================================================================
  // P0: NODE_PATH separator in bridge files
  // =========================================================================
  describe('P0: Bridge NODE_PATH separator', () => {
    const bridgeFiles = [
      'bridge/mcp-server.cjs',
      'bridge/team-bridge.cjs',
    ];

    for (const file of bridgeFiles) {
      describe(file, () => {
        let content: string;

        beforeEach(() => {
          content = readFileSync(join(packageRoot, file), 'utf-8');
        });

        it('should NOT have hardcoded colon separator', () => {
          expect(content).not.toMatch(/process\.env\.NODE_PATH \? ':' \+ process\.env\.NODE_PATH/);
        });

        it('should use platform-aware separator variable', () => {
          expect(content).toContain("process.platform === 'win32' ? ';' : ':'");
        });

        it('should use _sep variable for NODE_PATH concatenation', () => {
          expect(content).toMatch(/_sep \+ process\.env\.NODE_PATH/);
        });
      });
    }

    const buildScripts = [
      'scripts/build-mcp-server.mjs',
      'scripts/build-bridge-entry.mjs',
    ];

    for (const script of buildScripts) {
      it(`${script} should use platform-aware separator in banner`, () => {
        const content = readFileSync(join(packageRoot, script), 'utf-8');
        expect(content).toContain("process.platform === 'win32' ? ';' : ':'");
        expect(content).not.toMatch(/NODE_PATH \? ':' \+ process\.env\.NODE_PATH/);
      });
    }
  });

  // =========================================================================
  // P0: NODE_PATH separator logic validation
  // =========================================================================
  describe('P0: NODE_PATH separator logic', () => {
    it('should produce semicolon on win32', () => {
      expect(getSeparator('win32')).toBe(';');
    });

    it('should produce colon on darwin', () => {
      expect(getSeparator('darwin')).toBe(':');
    });

    it('should produce colon on linux', () => {
      expect(getSeparator('linux')).toBe(':');
    });

    it('should correctly build NODE_PATH with existing value on Windows', () => {
      const globalRoot = 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules';
      const existingNodePath = 'C:\\some\\other\\path';
      const sep = getSeparator('win32');
      const result = globalRoot + (existingNodePath ? sep + existingNodePath : '');
      expect(result).toBe('C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules;C:\\some\\other\\path');
      expect(result).not.toContain(':C:\\');
    });

    it('should correctly build NODE_PATH without existing value on Windows', () => {
      const globalRoot = 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules';
      const existingNodePath = '';
      const sep = getSeparator('win32');
      const result = globalRoot + (existingNodePath ? sep + existingNodePath : '');
      expect(result).toBe('C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules');
    });
  });

  // =========================================================================
  // P1: Call counts emoji vs ASCII
  // =========================================================================
  describe('P1: Call counts Windows ASCII fallback', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
    });

    it('should use emoji icons on macOS/Linux (current platform)', async () => {
      const { renderCallCounts } = await import('../../hud/elements/call-counts.js');
      const result = renderCallCounts(42, 7, 3);
      expect(result).toContain('\u{1F527}'); // wrench
      expect(result).toContain('\u{1F916}'); // robot
      expect(result).toContain('\u26A1');    // zap
    });

    it('should use ASCII icons on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.resetModules();

      const mod = await import('../../hud/elements/call-counts.js');
      const result = mod.renderCallCounts(42, 7, 3);
      expect(result).toBe('T:42 A:7 S:3');
      expect(result).not.toContain('\u{1F527}');
      expect(result).not.toContain('\u{1F916}');
      expect(result).not.toContain('\u26A1');
    });

    it('should return null for zero counts on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.resetModules();

      const mod = await import('../../hud/elements/call-counts.js');
      expect(mod.renderCallCounts(0, 0, 0)).toBeNull();
    });

    it('should render partial counts correctly on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.resetModules();

      const mod = await import('../../hud/elements/call-counts.js');
      expect(mod.renderCallCounts(10, 0, 0)).toBe('T:10');
      expect(mod.renderCallCounts(0, 5, 0)).toBe('A:5');
      expect(mod.renderCallCounts(0, 0, 2)).toBe('S:2');
    });
  });

  // =========================================================================
  // P1: Git shell option on Windows
  // =========================================================================
  describe('P1: Git execSync shell option', () => {
    it('git.ts should use conditional shell option', () => {
      const content = readFileSync(
        join(packageRoot, 'src', 'hud', 'elements', 'git.ts'),
        'utf-8',
      );
      expect(content).toContain("shell: process.platform === 'win32' ? 'cmd.exe' : undefined");
    });

    it('shell option logic should produce cmd.exe on win32', () => {
      expect(getShellOption('win32')).toBe('cmd.exe');
    });

    it('shell option logic should produce undefined on darwin', () => {
      expect(getShellOption('darwin')).toBeUndefined();
    });

    it('shell option logic should produce undefined on linux', () => {
      expect(getShellOption('linux')).toBeUndefined();
    });
  });

  // =========================================================================
  // P2: Safe mode auto-enable on Windows
  // =========================================================================
  describe('P2: Safe mode auto-enable on Windows', () => {
    it('index.ts should auto-enable safe mode on Windows', () => {
      const content = readFileSync(
        join(packageRoot, 'src', 'hud', 'index.ts'),
        'utf-8',
      );
      expect(content).toContain("process.platform === 'win32'");
      expect(content).toMatch(/config\.elements\.safeMode \|\| process\.platform === 'win32'/);
    });

    it('safe mode logic: config=false on Mac -> disabled', () => {
      expect(getSafeMode(false, 'darwin')).toBe(false);
    });

    it('safe mode logic: config=false on Windows -> auto-enabled', () => {
      expect(getSafeMode(false, 'win32')).toBe(true);
    });

    it('safe mode logic: config=true on Mac -> enabled', () => {
      expect(getSafeMode(true, 'darwin')).toBe(true);
    });

    it('safe mode logic: config=true on Windows -> enabled', () => {
      expect(getSafeMode(true, 'win32')).toBe(true);
    });

    it('safe mode logic: config=false on Linux -> disabled', () => {
      expect(getSafeMode(false, 'linux')).toBe(false);
    });
  });
});
