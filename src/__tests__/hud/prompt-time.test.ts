import { describe, it, expect } from 'vitest';
import { renderPromptTime } from '../../hud/elements/prompt-time.js';

describe('renderPromptTime', () => {
  it('should return null when promptTime is null', () => {
    expect(renderPromptTime(null)).toBeNull();
  });

  it('should render time in HH:MM:SS format', () => {
    const date = new Date(2026, 1, 24, 14, 30, 25);
    const result = renderPromptTime(date);
    expect(result).toContain('14:30:25');
    expect(result).toContain('prompt:');
  });

  it('should zero-pad single-digit hours, minutes, and seconds', () => {
    const date = new Date(2026, 0, 1, 9, 5, 3);
    const result = renderPromptTime(date);
    expect(result).toContain('09:05:03');
  });

  it('should handle midnight correctly', () => {
    const date = new Date(2026, 0, 1, 0, 0, 0);
    const result = renderPromptTime(date);
    expect(result).toContain('00:00:00');
  });
});
