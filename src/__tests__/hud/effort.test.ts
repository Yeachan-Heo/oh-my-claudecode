import { describe, it, expect } from 'vitest';
import { bold, cyan, dim, magenta, yellow } from '../../hud/colors.js';
import { renderEffort } from '../../hud/elements/effort.js';
import { getEffortLevel } from '../../hud/stdin.js';

describe('effort element', () => {
  it('reads the effort level from stdin', () => {
    expect(getEffortLevel({ effort: { level: 'xhigh' } })).toBe('xhigh');
    expect(getEffortLevel({ effort: { level: '  ' } })).toBeNull();
    expect(getEffortLevel({})).toBeNull();
  });

  it('returns null when no level is available', () => {
    expect(renderEffort(null)).toBeNull();
    expect(renderEffort(undefined)).toBeNull();
  });

  it('colors the level by intensity', () => {
    expect(renderEffort('low')).toBe(dim('effort:low'));
    expect(renderEffort('medium')).toBe(cyan('effort:medium'));
    expect(renderEffort('high')).toBe(yellow('effort:high'));
    expect(renderEffort('xhigh')).toBe(magenta('effort:xhigh'));
    expect(renderEffort('max')).toBe(bold(magenta('effort:max')));
    expect(renderEffort('future-level')).toBe(cyan('effort:future-level'));
  });
});
