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

    it('should use text format for thinking indicator by default', () => {
      expect(DEFAULT_HUD_CONFIG.elements.thinkingFormat).toBe('text');
    });
  });

  describe('PRESET_CONFIGS', () => {
    const presets = ['minimal', 'analytics', 'focused', 'full', 'opencode', 'dense'] as const;

    presets.forEach(preset => {
      it(`${preset} preset should use text thinkingFormat`, () => {
        expect(PRESET_CONFIGS[preset].thinkingFormat).toBe('text');
      });

      it(`${preset} preset should have gitRepo disabled`, () => {
        expect(PRESET_CONFIGS[preset].gitRepo).toBe(false);
      });

      it(`${preset} preset should have gitBranch disabled`, () => {
        expect(PRESET_CONFIGS[preset].gitBranch).toBe(false);
      });
    });
  });
});
