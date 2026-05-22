import { describe, it, expect } from 'vitest';
import { formatSessionDuration, renderSession } from '../../hud/elements/session.js';

describe('formatSessionDuration', () => {
  it('returns minutes under 1 hour', () => {
    expect(formatSessionDuration(0)).toBe('0m');
    expect(formatSessionDuration(1)).toBe('1m');
    expect(formatSessionDuration(42)).toBe('42m');
    expect(formatSessionDuration(59)).toBe('59m');
  });

  it('returns hours (no minutes) between 1h and 24h', () => {
    expect(formatSessionDuration(60)).toBe('1h');
    expect(formatSessionDuration(90)).toBe('1h');   // floor: 1h 30m → 1h
    expect(formatSessionDuration(120)).toBe('2h');
    expect(formatSessionDuration(1439)).toBe('23h');
  });

  it('returns days+hours past 24h', () => {
    expect(formatSessionDuration(1440)).toBe('1d');         // exact day → drop trailing 0h
    expect(formatSessionDuration(1500)).toBe('1d1h');
    expect(formatSessionDuration(2880)).toBe('2d');
    expect(formatSessionDuration(4755)).toBe('3d7h');       // 79.25h → 3d 7h
  });
});

describe('renderSession', () => {
  it('returns null for a null session', () => {
    expect(renderSession(null)).toBeNull();
  });

  it('includes the formatted duration in the output', () => {
    const out = renderSession({
      durationMinutes: 4755,
      messageCount: 100,
      health: 'healthy',
    });
    expect(out).toContain('3d7h');
    expect(out).not.toContain('4755m');
  });

  it('uses minute formatting for short sessions', () => {
    const out = renderSession({
      durationMinutes: 45,
      messageCount: 12,
      health: 'healthy',
    });
    expect(out).toContain('45m');
  });

  it('applies color codes based on health level', () => {
    const healthy = renderSession({ durationMinutes: 30, messageCount: 5, health: 'healthy' });
    const warning = renderSession({ durationMinutes: 30, messageCount: 5, health: 'warning' });
    const critical = renderSession({ durationMinutes: 30, messageCount: 5, health: 'critical' });
    expect(healthy).not.toBe(warning);
    expect(warning).not.toBe(critical);
    expect(healthy).not.toBe(critical);
  });
});
