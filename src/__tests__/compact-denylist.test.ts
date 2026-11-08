/**
 * Tests for issue #830: "Skill compact is not a prompt-based skill"
 *
 * When Claude Code triggers context compaction (/compact) or /clear,
 * the auto-slash-command hook must not attempt to load those as OMC skills.
 * Both commands belong to EXCLUDED_COMMANDS to prevent the error.
 */

import { describe, it, expect } from 'vitest';
import { EXCLUDED_COMMANDS } from '../hooks/auto-slash-command/constants.js';

describe('EXCLUDED_COMMANDS denylist (issue #830)', () => {
  it('should exclude "compact" to prevent skill-loading error on context compaction', () => {
    expect(EXCLUDED_COMMANDS.has('compact')).toBe(true);
  });

  it('should exclude "clear" (CC native command)', () => {
    expect(EXCLUDED_COMMANDS.has('clear')).toBe(true);
  });

  it('should exclude other CC native CLI commands', () => {
    expect(EXCLUDED_COMMANDS.has('help')).toBe(true);
    expect(EXCLUDED_COMMANDS.has('history')).toBe(true);
    expect(EXCLUDED_COMMANDS.has('exit')).toBe(true);
    expect(EXCLUDED_COMMANDS.has('quit')).toBe(true);
  });
});
