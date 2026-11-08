import { describe, it, expect } from 'vitest';
import { renderContextLimitWarning } from '../../hud/elements/context-warning.js';
import { DEFAULT_HUD_CONFIG } from '../../hud/types.js';

describe('renderContextLimitWarning', () => {
  describe('below threshold', () => {
    it('returns null when contextPercent is below threshold', () => {
      expect(renderContextLimitWarning(79, 80, false)).toBeNull();
    });

    it('returns null when contextPercent is 0', () => {
      expect(renderContextLimitWarning(0, 80, false)).toBeNull();
    });

    it('returns null when contextPercent equals threshold minus one', () => {
      expect(renderContextLimitWarning(49, 50, false)).toBeNull();
    });
  });

  describe('at or above threshold', () => {
    it('returns a string when contextPercent equals threshold', () => {
      const result = renderContextLimitWarning(80, 80, false);
      expect(result).not.toBeNull();
      expect(result).toContain('80%');
    });

    it('returns a string when contextPercent is above threshold', () => {
      const result = renderContextLimitWarning(85, 80, false);
      expect(result).not.toBeNull();
      expect(result).toContain('85%');
    });

    it('includes the threshold value in the warning', () => {
      const result = renderContextLimitWarning(82, 80, false);
      expect(result).toContain('80%');
    });

    it('includes /compact instruction when autoCompact is false', () => {
      const result = renderContextLimitWarning(80, 80, false);
      expect(result).toContain('/compact');
    });

    it('shows auto-compact queued message when autoCompact is true', () => {
      const result = renderContextLimitWarning(80, 80, true);
      expect(result).toContain('auto-compact queued');
      expect(result).not.toContain('/compact');
    });
  });

  describe('critical level (>=90%)', () => {
    it('uses critical marker at 90%', () => {
      const result = renderContextLimitWarning(90, 80, false);
      expect(result).not.toBeNull();
      expect(result).toContain('!!');
    });

    it('uses warning marker below 90%', () => {
      const result = renderContextLimitWarning(85, 80, false);
      // Single ! for warning, not !!
      expect(result).toContain('[!]');
    });
  });

  describe('boundary clamping', () => {
    it('clamps percent above 100 to 100', () => {
      const result = renderContextLimitWarning(150, 80, false);
      expect(result).toContain('100%');
    });

    it('treats negative percent as 0 (below any threshold)', () => {
      const result = renderContextLimitWarning(-5, 80, false);
      expect(result).toBeNull();
    });
  });

  describe('configurable threshold', () => {
    it('works with threshold of 90', () => {
      expect(renderContextLimitWarning(89, 90, false)).toBeNull();
      expect(renderContextLimitWarning(90, 90, false)).not.toBeNull();
    });

    it('works with threshold of 50', () => {
      expect(renderContextLimitWarning(49, 50, false)).toBeNull();
      expect(renderContextLimitWarning(50, 50, false)).not.toBeNull();
    });
  });
});

describe('DEFAULT_HUD_CONFIG contextLimitWarning', () => {
  it('has threshold of 80 by default', () => {
    expect(DEFAULT_HUD_CONFIG.contextLimitWarning.threshold).toBe(80);
  });

  it('has autoCompact disabled by default', () => {
    expect(DEFAULT_HUD_CONFIG.contextLimitWarning.autoCompact).toBe(false);
  });
});
