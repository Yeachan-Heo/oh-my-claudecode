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

    it('should enable model display by default when Claude Code provides reliable metadata', () => {
      expect(DEFAULT_HUD_CONFIG.elements.model).toBe(true);
      expect(DEFAULT_HUD_CONFIG.elements.modelFormat).toBe('versioned');
    });

    it('should use text format for thinking indicator by default', () => {
      expect(DEFAULT_HUD_CONFIG.elements.thinkingFormat).toBe('text');
    });

    it('should keep mission board disabled by default', () => {
      expect(DEFAULT_HUD_CONFIG.elements.missionBoard).toBe(false);
      expect(DEFAULT_HUD_CONFIG.missionBoard?.enabled).toBe(false);
    });

    it('should default wrapMode to truncate', () => {
      expect(DEFAULT_HUD_CONFIG.wrapMode).toBe('truncate');
    });

    it('should default session duration display to enabled', () => {
      expect(DEFAULT_HUD_CONFIG.elements.showSessionDuration).toBe(true);
    });

    it('should keep token usage display optional by default', () => {
      expect(DEFAULT_HUD_CONFIG.elements.showTokens).toBe(false);
    });
  });

  describe('PRESET_CONFIGS', () => {
    const presets = ['minimal', 'focused', 'full', 'opencode', 'dense'] as const;

    it('should use text thinkingFormat in all presets', () => {
      presets.forEach(preset => {
        expect(PRESET_CONFIGS[preset].thinkingFormat).toBe('text');
      });
    });

    it('should enable model display in all presets while render omits unavailable models', () => {
      presets.forEach(preset => {
        expect(PRESET_CONFIGS[preset].model).toBe(true);
        expect(PRESET_CONFIGS[preset].modelFormat).toBe('versioned');
      });
    });

    it('should have gitRepo enabled in every preset', () => {
      presets.forEach(preset => {
        expect(PRESET_CONFIGS[preset].gitRepo, `${preset}.gitRepo`).toBe(true);
      });
    });

    it('should have gitBranch enabled in every preset', () => {
      presets.forEach(preset => {
        expect(PRESET_CONFIGS[preset].gitBranch, `${preset}.gitBranch`).toBe(true);
      });
    });

    it('should keep token usage display disabled in all presets', () => {
      presets.forEach(preset => {
        expect(PRESET_CONFIGS[preset].showTokens).toBe(false);
      });
    });
  });
});
