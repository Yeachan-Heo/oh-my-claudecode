import { describe, it, expect } from 'vitest';
import { DEFAULT_HUD_CONFIG, PRESET_CONFIGS } from '../../hud/types.js';

describe('HUD Default Configuration', () => {
  describe('DEFAULT_HUD_CONFIG', () => {
    it('should have cwd disabled by default for backward compatibility', () => {
      expect(DEFAULT_HUD_CONFIG.elements.cwd).toBe(false);
    });

    it('should have gitRepo disabled by default for backward compatibility', () => {
      expect(DEFAULT_HUD_CONFIG.elements.gitRepo).toBe(false);
    });

    it('should have gitBranch disabled by default for backward compatibility', () => {
      expect(DEFAULT_HUD_CONFIG.elements.gitBranch).toBe(false);
    });

    it('should have model disabled by default for backward compatibility', () => {
      expect(DEFAULT_HUD_CONFIG.elements.model).toBe(false);
    });

    it('should use text format for thinking indicator by default', () => {
      expect(DEFAULT_HUD_CONFIG.elements.thinkingFormat).toBe('text');
    });
  });

  describe('PRESET_CONFIGS', () => {
    const presets = ['minimal', 'focused', 'full', 'opencode', 'dense'] as const;

    it('should use text thinkingFormat in all presets', () => {
      presets.forEach(preset => {
        expect(PRESET_CONFIGS[preset].thinkingFormat).toBe('text');
      });
    });

    it('should have gitRepo enabled in full and dense presets', () => {
      expect(PRESET_CONFIGS.full.gitRepo).toBe(true);
      expect(PRESET_CONFIGS.dense.gitRepo).toBe(true);
    });

    it('should have gitRepo disabled in minimal, focused, and opencode presets', () => {
      expect(PRESET_CONFIGS.minimal.gitRepo).toBe(false);
      expect(PRESET_CONFIGS.focused.gitRepo).toBe(false);
      expect(PRESET_CONFIGS.opencode.gitRepo).toBe(false);
    });

    it('should have gitBranch enabled in focused, full, opencode, and dense presets', () => {
      expect(PRESET_CONFIGS.focused.gitBranch).toBe(true);
      expect(PRESET_CONFIGS.full.gitBranch).toBe(true);
      expect(PRESET_CONFIGS.opencode.gitBranch).toBe(true);
      expect(PRESET_CONFIGS.dense.gitBranch).toBe(true);
    });

    it('should have gitBranch disabled in minimal preset', () => {
      expect(PRESET_CONFIGS.minimal.gitBranch).toBe(false);
    });

    it('should have model disabled in all presets', () => {
      presets.forEach(preset => {
        expect(PRESET_CONFIGS[preset].model).toBe(false);
      });
    });
  });
});
