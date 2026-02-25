import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  getSkillProtection,
  getSkillConfig,
  readSkillActiveState,
  writeSkillActiveState,
  clearSkillActiveState,
  isSkillStateStale,
  checkSkillActiveState,
  type SkillActiveState,
} from '../index.js';

function makeTempDir(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'skill-state-'));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
  return tempDir;
}

describe('skill-state', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // getSkillProtection
  // -----------------------------------------------------------------------
  describe('getSkillProtection', () => {
    it('returns none for skills with dedicated mode state', () => {
      expect(getSkillProtection('ralph')).toBe('none');
      expect(getSkillProtection('autopilot')).toBe('none');
      expect(getSkillProtection('team')).toBe('none');
      expect(getSkillProtection('ultrawork')).toBe('none');
      expect(getSkillProtection('cancel')).toBe('none');
    });

    it('returns none for instant/read-only skills', () => {
      expect(getSkillProtection('trace')).toBe('none');
      expect(getSkillProtection('hud')).toBe('none');
      expect(getSkillProtection('omc-help')).toBe('none');
      expect(getSkillProtection('omc-doctor')).toBe('none');
    });

    it('returns light for simple agent shortcuts', () => {
      expect(getSkillProtection('tdd')).toBe('light');
      expect(getSkillProtection('build-fix')).toBe('light');
      expect(getSkillProtection('analyze')).toBe('light');
    });

    it('returns medium for review/planning skills', () => {
      expect(getSkillProtection('code-review')).toBe('medium');
      expect(getSkillProtection('security-review')).toBe('medium');
      expect(getSkillProtection('plan')).toBe('medium');
      expect(getSkillProtection('external-context')).toBe('medium');
    });

    it('returns heavy for long-running skills', () => {
      expect(getSkillProtection('deepinit')).toBe('heavy');
    });

    it('defaults to light for unknown skills', () => {
      expect(getSkillProtection('unknown-skill')).toBe('light');
      expect(getSkillProtection('my-custom-skill')).toBe('light');
    });

    it('strips oh-my-claudecode: prefix', () => {
      expect(getSkillProtection('oh-my-claudecode:code-review')).toBe('medium');
      expect(getSkillProtection('oh-my-claudecode:ralph')).toBe('none');
    });

    it('is case-insensitive', () => {
      expect(getSkillProtection('TDD')).toBe('light');
      expect(getSkillProtection('Code-Review')).toBe('medium');
    });
  });

  // -----------------------------------------------------------------------
  // getSkillConfig
  // -----------------------------------------------------------------------
  describe('getSkillConfig', () => {
    it('returns correct config for light protection', () => {
      const config = getSkillConfig('tdd');
      expect(config.maxReinforcements).toBe(3);
      expect(config.staleTtlMs).toBe(5 * 60 * 1000);
    });

    it('returns correct config for medium protection', () => {
      const config = getSkillConfig('code-review');
      expect(config.maxReinforcements).toBe(5);
      expect(config.staleTtlMs).toBe(15 * 60 * 1000);
    });

    it('returns correct config for heavy protection', () => {
      const config = getSkillConfig('deepinit');
      expect(config.maxReinforcements).toBe(10);
      expect(config.staleTtlMs).toBe(30 * 60 * 1000);
    });

    it('returns zero config for none protection', () => {
      const config = getSkillConfig('ralph');
      expect(config.maxReinforcements).toBe(0);
      expect(config.staleTtlMs).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // writeSkillActiveState
  // -----------------------------------------------------------------------
  describe('writeSkillActiveState', () => {
    it('writes state file for protected skills', () => {
      const state = writeSkillActiveState(tempDir, 'code-review', 'session-1');
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.skill_name).toBe('code-review');
      expect(state!.session_id).toBe('session-1');
      expect(state!.reinforcement_count).toBe(0);
      expect(state!.max_reinforcements).toBe(5);
    });

    it('returns null for skills with none protection', () => {
      const state = writeSkillActiveState(tempDir, 'ralph', 'session-1');
      expect(state).toBeNull();
    });

    it('creates state file on disk', () => {
      writeSkillActiveState(tempDir, 'tdd', 'session-1');
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', 'session-1');
      const files = existsSync(stateDir);
      expect(files).toBe(true);
    });

    it('strips namespace prefix from skill name', () => {
      const state = writeSkillActiveState(tempDir, 'oh-my-claudecode:code-review', 'session-1');
      expect(state!.skill_name).toBe('code-review');
    });

    it('overwrites existing state when new skill is invoked', () => {
      writeSkillActiveState(tempDir, 'code-review', 'session-1');
      const state2 = writeSkillActiveState(tempDir, 'security-review', 'session-1');
      expect(state2!.skill_name).toBe('security-review');

      const readBack = readSkillActiveState(tempDir, 'session-1');
      expect(readBack!.skill_name).toBe('security-review');
    });
  });

  // -----------------------------------------------------------------------
  // readSkillActiveState
  // -----------------------------------------------------------------------
  describe('readSkillActiveState', () => {
    it('returns null when no state exists', () => {
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
    });

    it('reads written state correctly', () => {
      writeSkillActiveState(tempDir, 'plan', 'session-1');
      const state = readSkillActiveState(tempDir, 'session-1');
      expect(state).not.toBeNull();
      expect(state!.skill_name).toBe('plan');
      expect(state!.active).toBe(true);
    });

    it('returns null for invalid JSON', () => {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', 'session-1');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'skill-active-state.json'), 'not json');
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // clearSkillActiveState
  // -----------------------------------------------------------------------
  describe('clearSkillActiveState', () => {
    it('removes the state file', () => {
      writeSkillActiveState(tempDir, 'tdd', 'session-1');
      expect(readSkillActiveState(tempDir, 'session-1')).not.toBeNull();

      clearSkillActiveState(tempDir, 'session-1');
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
    });

    it('returns true when no state exists', () => {
      expect(clearSkillActiveState(tempDir, 'session-1')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // isSkillStateStale
  // -----------------------------------------------------------------------
  describe('isSkillStateStale', () => {
    it('returns false for fresh state', () => {
      const state: SkillActiveState = {
        active: true,
        skill_name: 'tdd',
        started_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        reinforcement_count: 0,
        max_reinforcements: 3,
        stale_ttl_ms: 5 * 60 * 1000,
      };
      expect(isSkillStateStale(state)).toBe(false);
    });

    it('returns true for inactive state', () => {
      const state: SkillActiveState = {
        active: false,
        skill_name: 'tdd',
        started_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        reinforcement_count: 0,
        max_reinforcements: 3,
        stale_ttl_ms: 5 * 60 * 1000,
      };
      expect(isSkillStateStale(state)).toBe(true);
    });

    it('returns true when TTL is exceeded', () => {
      const past = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      const state: SkillActiveState = {
        active: true,
        skill_name: 'tdd',
        started_at: past,
        last_checked_at: past,
        reinforcement_count: 0,
        max_reinforcements: 3,
        stale_ttl_ms: 5 * 60 * 1000, // 5 min TTL
      };
      expect(isSkillStateStale(state)).toBe(true);
    });

    it('uses last_checked_at over started_at when more recent', () => {
      const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      const state: SkillActiveState = {
        active: true,
        skill_name: 'code-review',
        started_at: past,
        last_checked_at: recent,
        reinforcement_count: 2,
        max_reinforcements: 5,
        stale_ttl_ms: 5 * 60 * 1000,
      };
      expect(isSkillStateStale(state)).toBe(false);
    });

    it('returns true when no timestamps are available', () => {
      const state: SkillActiveState = {
        active: true,
        skill_name: 'tdd',
        started_at: '',
        last_checked_at: '',
        reinforcement_count: 0,
        max_reinforcements: 3,
        stale_ttl_ms: 5 * 60 * 1000,
      };
      expect(isSkillStateStale(state)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // checkSkillActiveState (Stop hook integration)
  // -----------------------------------------------------------------------
  describe('checkSkillActiveState', () => {
    it('returns shouldBlock=false when no state exists', () => {
      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(false);
    });

    it('blocks stop when skill is active within reinforcement limit', () => {
      writeSkillActiveState(tempDir, 'code-review', 'session-1');
      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(true);
      expect(result.message).toContain('code-review');
      expect(result.skillName).toBe('code-review');
    });

    it('increments reinforcement count on each check', () => {
      writeSkillActiveState(tempDir, 'tdd', 'session-1');

      checkSkillActiveState(tempDir, 'session-1'); // count → 1
      checkSkillActiveState(tempDir, 'session-1'); // count → 2

      const state = readSkillActiveState(tempDir, 'session-1');
      expect(state!.reinforcement_count).toBe(2);
    });

    it('allows stop when reinforcement limit is reached', () => {
      writeSkillActiveState(tempDir, 'tdd', 'session-1'); // max_reinforcements = 3

      checkSkillActiveState(tempDir, 'session-1'); // 1
      checkSkillActiveState(tempDir, 'session-1'); // 2
      checkSkillActiveState(tempDir, 'session-1'); // 3

      // 4th check should allow stop (3 >= 3)
      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(false);
    });

    it('clears state when reinforcement limit is reached', () => {
      writeSkillActiveState(tempDir, 'tdd', 'session-1');

      for (let i = 0; i < 3; i++) {
        checkSkillActiveState(tempDir, 'session-1');
      }

      // State should be cleared
      checkSkillActiveState(tempDir, 'session-1'); // triggers clear
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
    });

    it('respects session isolation', () => {
      writeSkillActiveState(tempDir, 'code-review', 'session-1');

      // Different session should not be blocked
      const result = checkSkillActiveState(tempDir, 'session-2');
      expect(result.shouldBlock).toBe(false);
    });

    it('clears stale state and allows stop', () => {
      writeSkillActiveState(tempDir, 'tdd', 'session-1');

      // Manually make the state stale
      const state = readSkillActiveState(tempDir, 'session-1')!;
      const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      state.started_at = past;
      state.last_checked_at = past;
      const statePath = join(tempDir, '.omc', 'state', 'sessions', 'session-1', 'skill-active-state.json');
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(false);
      // State should be cleaned up
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
    });

    it('includes skill name in blocking message', () => {
      writeSkillActiveState(tempDir, 'security-review', 'session-1');
      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.message).toContain('security-review');
      expect(result.message).toContain('SKILL ACTIVE');
    });

    it('works without session ID (legacy path)', () => {
      writeSkillActiveState(tempDir, 'analyze');
      const result = checkSkillActiveState(tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.skillName).toBe('analyze');
    });
  });
});
