/**
 * Tests for the effort HUD element.
 */

import { describe, it, expect } from 'vitest';
import { renderEffort } from '../../hud/elements/effort.js';

describe('renderEffort', () => {
  it('returns null for null/undefined/blank', () => {
    expect(renderEffort(null)).toBeNull();
    expect(renderEffort(undefined)).toBeNull();
    expect(renderEffort('')).toBeNull();
    expect(renderEffort('   ')).toBeNull();
  });

  it('renders the effort level with the effort: label', () => {
    const out = renderEffort('xhigh')!;
    expect(out).toContain('effort:');
    expect(out).toContain('xhigh');
  });

  it('trims surrounding whitespace from the level', () => {
    const out = renderEffort('  high  ')!;
    expect(out).toContain('high');
    expect(out).not.toContain('  high  ');
  });
});
