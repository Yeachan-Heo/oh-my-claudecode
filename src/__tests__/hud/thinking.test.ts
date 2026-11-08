import { describe, it, expect } from 'vitest';
import { renderThinking } from '../../hud/elements/thinking.js';
import type { ThinkingState } from '../../hud/types.js';

describe('renderThinking', () => {
  const activeState: ThinkingState = { active: true };
  const inactiveState: ThinkingState = { active: false };

  it('returns null for null state', () => {
    expect(renderThinking(null)).toBeNull();
  });

  it('returns null for inactive state', () => {
    expect(renderThinking(inactiveState)).toBeNull();
  });

  it('returns styled "thinking" for text format (default)', () => {
    const result = renderThinking(activeState);
    expect(result).toContain('thinking');
    expect(result).toContain('\x1b[36m'); // cyan
  });

  it('returns 💭 for bubble format', () => {
    expect(renderThinking(activeState, 'bubble')).toBe('💭');
  });

  it('returns 🧠 for brain format', () => {
    expect(renderThinking(activeState, 'brain')).toBe('🧠');
  });

  it('returns 🤔 for face format', () => {
    expect(renderThinking(activeState, 'face')).toBe('🤔');
  });

  it('returns styled "thinking" for explicit text format', () => {
    const result = renderThinking(activeState, 'text');
    expect(result).toContain('thinking');
    expect(result).toContain('\x1b[36m'); // cyan
  });
});
