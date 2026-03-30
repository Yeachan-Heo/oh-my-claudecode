import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
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

function writeSubagentTrackingState(
  tempDir: string,
  agents: Array<Record<string, unknown>>,
): void {
  const stateDir = join(tempDir, '.omc', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'subagent-tracking.json'),
    JSON.stringify(
      {
        agents,
        total_spawned: agents.length,
        total_completed: agents.filter((agent) => agent.status === 'completed').length,
        total_failed: agents.filter((agent) => agent.status === 'failed').length,
        last_updated: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
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

    it('returns light only for explicitly protected simple utility skills', () => {
      expect(getSkillProtection('skill')).toBe('light');
      expect(getSkillProtection('configure-notifications')).toBe('light');
      expect(getSkillProtection('build-fix')).toBe('none');
      expect(getSkillProtection('analyze')).toBe('none');
    });

    it('returns medium for review/planning skills', () => {
      expect(getSkillProtection('plan')).toBe('medium');
      expect(getSkillProtection('review')).toBe('medium');
      expect(getSkillProtection('external-context')).toBe('medium');
    });

    it('returns none for ralplan because persistent-mode enforces it directly', () => {
      expect(getSkillProtection('ralplan')).toBe('none');
    });

    it('returns heavy for long-running skills', () => {
      expect(getSkillProtection('deepinit')).toBe('heavy');
    });

    it('defaults to none for unknown/non-OMC skills', () => {
      expect(getSkillProtection('unknown-skill')).toBe('none');
      expect(getSkillProtection('my-custom-skill')).toBe('none');
    });

    it('strips oh-my-claudecode: prefix', () => {
      expect(getSkillProtection('oh-my-claudecode:plan')).toBe('medium');
      expect(getSkillProtection('oh-my-claudecode:ralph')).toBe('none');
    });

    it('is case-insensitive', () => {
      expect(getSkillProtection('SKILL')).toBe('light');
      expect(getSkillProtection('Plan')).toBe('medium');
    });

    it('returns none for project custom skills with same name as OMC skills (issue #1581)', () => {
      // rawSkillName without oh-my-claudecode: prefix → project custom skill
      expect(getSkillProtection('plan', 'plan')).toBe('none');
      expect(getSkillProtection('review', 'review')).toBe('none');
      expect(getSkillProtection('tdd', 'tdd')).toBe('none');
    });

    it('returns protection for OMC skills when rawSkillName has prefix', () => {
      expect(getSkillProtection('plan', 'oh-my-claudecode:plan')).toBe('medium');
      expect(getSkillProtection('deepinit', 'oh-my-claudecode:deepinit')).toBe('heavy');
    });

    it('returns none for other plugin skills with rawSkillName', () => {
      // ouroboros:plan, claude-mem:make-plan etc. should not get OMC protection
      expect(getSkillProtection('plan', 'ouroboros:plan')).toBe('none');
      expect(getSkillProtection('make-plan', 'claude-mem:make-plan')).toBe('none');
    });

    it('falls back to map lookup when rawSkillName is not provided', () => {
      // Backward compatibility: no rawSkillName → use SKILL_PROTECTION map
      expect(getSkillProtection('plan')).toBe('medium');
      expect(getSkillProtection('deepinit')).toBe('heavy');
    });
  });

  // -----------------------------------------------------------------------
  // getSkillConfig
  // -----------------------------------------------------------------------
  describe('getSkillConfig', () => {
    it('returns correct config for light protection', () => {
      const config = getSkillConfig('skill');
      expect(config.maxReinforcements).toBe(3);
      expect(config.staleTtlMs).toBe(5 * 60 * 1000);
    });

    it('returns correct config for medium protection', () => {
      const config = getSkillConfig('plan');
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
      const state = writeSkillActiveState(tempDir, 'plan', 'session-1');
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.skill_name).toBe('plan');
      expect(state!.session_id).toBe('session-1');
      expect(state!.reinforcement_count).toBe(0);
      expect(state!.max_reinforcements).toBe(5);
    });

    it('returns null for skills with none protection', () => {
      const state = writeSkillActiveState(tempDir, 'ralph', 'session-1');
      expect(state).toBeNull();
    });

    it('does not write state for unknown/custom skills', () => {
      const state = writeSkillActiveState(tempDir, 'phase-resume', 'session-1');

      expect(state).toBeNull();
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
      expect(existsSync(join(tempDir, '.omc', 'state', 'sessions', 'session-1'))).toBe(false);
    });

    it('creates state file on disk', () => {
      writeSkillActiveState(tempDir, 'skill', 'session-1');
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', 'session-1');
      const files = existsSync(stateDir);
      expect(files).toBe(true);
    });

    it('strips namespace prefix from skill name', () => {
      const state = writeSkillActiveState(tempDir, 'oh-my-claudecode:plan', 'session-1');
      expect(state!.skill_name).toBe('plan');
    });

    it('does not write state for project custom skills with same name as OMC skills (issue #1581)', () => {
      // rawSkillName='plan' (no prefix) → project custom skill → no state
      const state = writeSkillActiveState(tempDir, 'plan', 'session-1', 'plan');
      expect(state).toBeNull();
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
    });

    it('writes state for OMC skills when rawSkillName has prefix', () => {
      const state = writeSkillActiveState(tempDir, 'plan', 'session-1', 'oh-my-claudecode:plan');
      expect(state).not.toBeNull();
      expect(state!.skill_name).toBe('plan');
      expect(state!.max_reinforcements).toBe(5);
    });

    it('does not overwrite when a different skill is already active (nesting guard)', () => {
      writeSkillActiveState(tempDir, 'plan', 'session-1');
      const state2 = writeSkillActiveState(tempDir, 'external-context', 'session-1');
      expect(state2).toBeNull();

      const readBack = readSkillActiveState(tempDir, 'session-1');
      expect(readBack!.skill_name).toBe('plan');
    });

    it('allows re-invocation of the same skill', () => {
      const state1 = writeSkillActiveState(tempDir, 'plan', 'session-1');
      expect(state1).not.toBeNull();
      expect(state1!.skill_name).toBe('plan');

      const state2 = writeSkillActiveState(tempDir, 'plan', 'session-1');
      expect(state2).not.toBeNull();
      expect(state2!.skill_name).toBe('plan');

      const readBack = readSkillActiveState(tempDir, 'session-1');
      expect(readBack!.skill_name).toBe('plan');
    });

    it('does not overwrite when mcp-setup is invoked inside omc-setup (canonical nesting scenario)', () => {
      writeSkillActiveState(tempDir, 'omc-setup', 'session-1');
      const child = writeSkillActiveState(tempDir, 'mcp-setup', 'session-1');
      expect(child).toBeNull();
      expect(readSkillActiveState(tempDir, 'session-1')!.skill_name).toBe('omc-setup');
    });

    it('blocks triple nesting: third child cannot overwrite grandparent', () => {
      writeSkillActiveState(tempDir, 'omc-setup', 'session-1');
      writeSkillActiveState(tempDir, 'mcp-setup', 'session-1'); // blocked
      const grandchild = writeSkillActiveState(tempDir, 'plan', 'session-1');
      expect(grandchild).toBeNull();
      expect(readSkillActiveState(tempDir, 'session-1')!.skill_name).toBe('omc-setup');
    });

    it('re-invocation resets reinforcement count', () => {
      writeSkillActiveState(tempDir, 'plan', 'session-1');

      // Simulate some reinforcement checks
      checkSkillActiveState(tempDir, 'session-1');
      checkSkillActiveState(tempDir, 'session-1');
      const stateBeforeRefresh = readSkillActiveState(tempDir, 'session-1');
      expect(stateBeforeRefresh!.reinforcement_count).toBe(2);

      // Re-invoke same skill
      writeSkillActiveState(tempDir, 'plan', 'session-1');
      const stateAfterRefresh = readSkillActiveState(tempDir, 'session-1');
      expect(stateAfterRefresh!.reinforcement_count).toBe(0);
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
      writeSkillActiveState(tempDir, 'skill', 'session-1');
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
        skill_name: 'skill',
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
        skill_name: 'skill',
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
        skill_name: 'skill',
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
        skill_name: 'plan',
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
        skill_name: 'skill',
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
      writeSkillActiveState(tempDir, 'plan', 'session-1');
      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(true);
      expect(result.message).toContain('plan');
      expect(result.skillName).toBe('plan');
    });

    it('increments reinforcement count on each check', () => {
      writeSkillActiveState(tempDir, 'skill', 'session-1');

      checkSkillActiveState(tempDir, 'session-1'); // count → 1
      checkSkillActiveState(tempDir, 'session-1'); // count → 2

      const state = readSkillActiveState(tempDir, 'session-1');
      expect(state!.reinforcement_count).toBe(2);
    });

    it('allows stop when reinforcement limit is reached', () => {
      writeSkillActiveState(tempDir, 'skill', 'session-1'); // max_reinforcements = 3

      checkSkillActiveState(tempDir, 'session-1'); // 1
      checkSkillActiveState(tempDir, 'session-1'); // 2
      checkSkillActiveState(tempDir, 'session-1'); // 3

      // 4th check should allow stop (3 >= 3)
      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(false);
    });

    it('clears state when reinforcement limit is reached', () => {
      writeSkillActiveState(tempDir, 'skill', 'session-1');

      for (let i = 0; i < 3; i++) {
        checkSkillActiveState(tempDir, 'session-1');
      }

      // State should be cleared
      checkSkillActiveState(tempDir, 'session-1'); // triggers clear
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();
    });

    it('respects session isolation', () => {
      writeSkillActiveState(tempDir, 'plan', 'session-1');

      // Different session should not be blocked
      const result = checkSkillActiveState(tempDir, 'session-2');
      expect(result.shouldBlock).toBe(false);
    });

    it('allows orchestrator idle while delegated subagents are still running', () => {
      writeSkillActiveState(tempDir, 'plan', 'session-1');
      writeSubagentTrackingState(tempDir, [
        {
          agent_id: 'agent-1',
          agent_type: 'executor',
          started_at: new Date().toISOString(),
          parent_mode: 'none',
          status: 'running',
        },
      ]);

      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(false);

      const state = readSkillActiveState(tempDir, 'session-1');
      expect(state?.reinforcement_count).toBe(0);
    });

    it('clears stale state and allows stop', () => {
      writeSkillActiveState(tempDir, 'skill', 'session-1');

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
      writeSkillActiveState(tempDir, 'plan', 'session-1');
      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.message).toContain('plan');
      expect(result.message).toContain('SKILL ACTIVE');
    });

    it('works without session ID (legacy path)', () => {
      writeSkillActiveState(tempDir, 'skill');
      const result = checkSkillActiveState(tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.skillName).toBe('skill');
    });

    it('still blocks stop after a nested skill invocation was rejected', () => {
      writeSkillActiveState(tempDir, 'plan', 'session-1');
      writeSkillActiveState(tempDir, 'external-context', 'session-1'); // blocked

      const result = checkSkillActiveState(tempDir, 'session-1');
      expect(result.shouldBlock).toBe(true);
      expect(result.skillName).toBe('plan');
    });

    it('nesting-aware clear: child completion preserves parent state, parent completion clears it', () => {
      // Simulates the full omc-setup → mcp-setup lifecycle including
      // the PostToolUse nesting-aware clear logic from bridge.ts:1828-1840.
      //
      // This is the direct verification for the PR test plan item:
      // "Verify stop hook no longer blocks after omc-setup completes with nested mcp-setup"

      // 1. Parent skill (omc-setup) starts
      writeSkillActiveState(tempDir, 'omc-setup', 'session-1');
      expect(readSkillActiveState(tempDir, 'session-1')!.skill_name).toBe('omc-setup');

      // 2. Child skill (mcp-setup) starts — nesting guard blocks write
      const childWrite = writeSkillActiveState(tempDir, 'mcp-setup', 'session-1');
      expect(childWrite).toBeNull();

      // 3. Child skill completes — simulate PostToolUse nesting-aware clear
      //    bridge.ts logic: only clear if completing skill owns the state
      const stateAfterChildDone = readSkillActiveState(tempDir, 'session-1');
      const completingChild = 'mcp-setup';
      if (!stateAfterChildDone || !stateAfterChildDone.active || stateAfterChildDone.skill_name === completingChild) {
        clearSkillActiveState(tempDir, 'session-1');
      }
      // Parent state must survive — child does not own it
      const parentState = readSkillActiveState(tempDir, 'session-1');
      expect(parentState).not.toBeNull();
      expect(parentState!.skill_name).toBe('omc-setup');
      expect(parentState!.active).toBe(true);

      // 4. Stop hook still blocks (parent is still active)
      const stopCheck = checkSkillActiveState(tempDir, 'session-1');
      expect(stopCheck.shouldBlock).toBe(true);
      expect(stopCheck.skillName).toBe('omc-setup');

      // 5. Parent skill completes — simulate PostToolUse nesting-aware clear
      const stateAfterParentDone = readSkillActiveState(tempDir, 'session-1');
      const completingParent = 'omc-setup';
      if (!stateAfterParentDone || !stateAfterParentDone.active || stateAfterParentDone.skill_name === completingParent) {
        clearSkillActiveState(tempDir, 'session-1');
      }
      // State must be cleared now
      expect(readSkillActiveState(tempDir, 'session-1')).toBeNull();

      // 6. Stop hook no longer blocks
      const finalCheck = checkSkillActiveState(tempDir, 'session-1');
      expect(finalCheck.shouldBlock).toBe(false);
    });
  });
});
