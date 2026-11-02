import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCmuxSurfaceTarget } from '../tmux-session.js';

describe('issue #4816: isCmuxSurfaceTarget', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function inCmux(): void {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('CMUX_SURFACE_ID', '5F4BFAF8-F133-41C9-BCB5-75801B364168');
  }

  it.each(['w234:p13', 'w2FQ:p16', 'w2HF:p3'])('never treats the herdr pane id %s as a cmux surface', (id) => {
    inCmux();
    expect(isCmuxSurfaceTarget(id)).toBe(false);
  });

  it('never treats a tmux pane id as a cmux surface', () => {
    inCmux();
    expect(isCmuxSurfaceTarget('%2')).toBe(false);
  });

  it.each(['surface:1000060015', 'C0D4B400-6C27-4957-BD01-32735B2251CD', 'cmux-worker-1'])(
    'treats %s as a cmux surface inside a cmux session',
    (id) => {
      inCmux();
      expect(isCmuxSurfaceTarget(id)).toBe(true);
    },
  );

  it('treats no pane id as a cmux surface outside a cmux session', () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('CMUX_SURFACE_ID', '');
    expect(isCmuxSurfaceTarget('surface:1000060015')).toBe(false);
    expect(isCmuxSurfaceTarget('w234:p13')).toBe(false);
  });

  it('rejects empty and missing ids', () => {
    inCmux();
    expect(isCmuxSurfaceTarget('')).toBe(false);
    expect(isCmuxSurfaceTarget('  ')).toBe(false);
    expect(isCmuxSurfaceTarget(undefined)).toBe(false);
  });
});
