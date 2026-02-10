import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readHudConfig } from '../../hud/state.js';
import { DEFAULT_HUD_CONFIG } from '../../hud/types.js';

// Mock fs and os modules
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/Users/testuser',
}));

import { existsSync, readFileSync } from 'node:fs';
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('readHudConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('priority order', () => {
    it('returns defaults when no config files exist', () => {
      mockExistsSync.mockReturnValue(false);

      const config = readHudConfig();

      expect(config).toEqual(DEFAULT_HUD_CONFIG);
    });

    it('reads from settings.json omcHud key first', () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s);
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({
        omcHud: {
          elements: {
            gitRepo: true,
            gitBranch: true,
          }
        }
      }));

      const config = readHudConfig();

      expect(config.elements.gitRepo).toBe(true);
      expect(config.elements.gitBranch).toBe(true);
    });

    it('falls back to legacy hud-config.json when settings.json has no omcHud', () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s) ||
               /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(s);
      });
      mockReadFileSync.mockImplementation((path) => {
        const s = String(path);
        if (/[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s)) {
          return JSON.stringify({ someOtherKey: true });
        }
        if (/[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(s)) {
          return JSON.stringify({
            elements: {
              cwd: true,
            }
          });
        }
        return '{}';
      });

      const config = readHudConfig();

      expect(config.elements.cwd).toBe(true);
    });

    it('prefers settings.json over legacy hud-config.json', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path) => {
        const s = String(path);
        if (/[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s)) {
          return JSON.stringify({
            omcHud: {
              elements: {
                gitRepo: true,
              }
            }
          });
        }
        if (/[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(s)) {
          return JSON.stringify({
            elements: {
              gitRepo: false,
              cwd: true,
            }
          });
        }
        return '{}';
      });

      const config = readHudConfig();

      // Should use settings.json value, not legacy
      expect(config.elements.gitRepo).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns defaults when settings.json is invalid JSON', () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s);
      });
      mockReadFileSync.mockReturnValue('invalid json');

      const config = readHudConfig();

      expect(config).toEqual(DEFAULT_HUD_CONFIG);
    });

    it('falls back to legacy when settings.json read fails', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path) => {
        const s = String(path);
        if (/[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s)) {
          throw new Error('Read error');
        }
        if (/[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(s)) {
          return JSON.stringify({
            elements: { cwd: true }
          });
        }
        return '{}';
      });

      const config = readHudConfig();

      expect(config.elements.cwd).toBe(true);
    });
  });

  describe('merging with defaults', () => {
    it('merges partial config with defaults', () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s);
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({
        omcHud: {
          elements: {
            gitRepo: true,
          }
        }
      }));

      const config = readHudConfig();

      // Custom value
      expect(config.elements.gitRepo).toBe(true);
      // Default values preserved
      expect(config.elements.omcLabel).toBe(DEFAULT_HUD_CONFIG.elements.omcLabel);
      expect(config.elements.contextBar).toBe(DEFAULT_HUD_CONFIG.elements.contextBar);
      expect(config.preset).toBe(DEFAULT_HUD_CONFIG.preset);
    });

    it('merges thresholds with defaults', () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s);
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({
        omcHud: {
          thresholds: {
            contextWarning: 80,
          }
        }
      }));

      const config = readHudConfig();

      expect(config.thresholds.contextWarning).toBe(80);
      expect(config.thresholds.contextCritical).toBe(DEFAULT_HUD_CONFIG.thresholds.contextCritical);
    });
  });
});
