import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { getSkillProtection, getSkillConfig, readSkillActiveState, writeSkillActiveState, clearSkillActiveState, isSkillStateStale, checkSkillActiveState, readSkillActiveStateNormalized, writeSkillActiveStateCopies, upsertWorkflowSkillSlot, markWorkflowSkillCompleted, clearWorkflowSkillSlot, pruneExpiredWorkflowSkillTombstones, resolveAuthoritativeWorkflowSkill, emptySkillActiveStateV2, WORKFLOW_TOMBSTONE_TTL_MS, } from '../index.js';
function makeTempDir() {
    const tempDir = mkdtempSync(join(tmpdir(), 'skill-state-'));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    return tempDir;
}
function writeSubagentTrackingState(tempDir, agents) {
    const stateDir = join(tempDir, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'subagent-tracking-state.json'), JSON.stringify({
        agents,
        total_spawned: agents.length,
        total_completed: agents.filter((agent) => agent.status === 'completed').length,
        total_failed: agents.filter((agent) => agent.status === 'failed').length,
        last_updated: new Date().toISOString(),
    }, null, 2));
}
describe('skill-state', () => {
    let tempDir;
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
            expect(state.active).toBe(true);
            expect(state.skill_name).toBe('plan');
            expect(state.session_id).toBe('session-1');
            expect(state.reinforcement_count).toBe(0);
            expect(state.max_reinforcements).toBe(5);
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
            expect(state.skill_name).toBe('plan');
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
            expect(state.skill_name).toBe('plan');
            expect(state.max_reinforcements).toBe(5);
        });
        it('does not overwrite when a different skill is already active (nesting guard)', () => {
            writeSkillActiveState(tempDir, 'plan', 'session-1');
            const state2 = writeSkillActiveState(tempDir, 'external-context', 'session-1');
            expect(state2).toBeNull();
            const readBack = readSkillActiveState(tempDir, 'session-1');
            expect(readBack.skill_name).toBe('plan');
        });
        it('allows re-invocation of the same skill', () => {
            const state1 = writeSkillActiveState(tempDir, 'plan', 'session-1');
            expect(state1).not.toBeNull();
            expect(state1.skill_name).toBe('plan');
            const state2 = writeSkillActiveState(tempDir, 'plan', 'session-1');
            expect(state2).not.toBeNull();
            expect(state2.skill_name).toBe('plan');
            const readBack = readSkillActiveState(tempDir, 'session-1');
            expect(readBack.skill_name).toBe('plan');
        });
        it('does not overwrite when mcp-setup is invoked inside omc-setup (canonical nesting scenario)', () => {
            writeSkillActiveState(tempDir, 'omc-setup', 'session-1');
            const child = writeSkillActiveState(tempDir, 'mcp-setup', 'session-1');
            expect(child).toBeNull();
            expect(readSkillActiveState(tempDir, 'session-1').skill_name).toBe('omc-setup');
        });
        it('blocks triple nesting: third child cannot overwrite grandparent', () => {
            writeSkillActiveState(tempDir, 'omc-setup', 'session-1');
            writeSkillActiveState(tempDir, 'mcp-setup', 'session-1'); // blocked
            const grandchild = writeSkillActiveState(tempDir, 'plan', 'session-1');
            expect(grandchild).toBeNull();
            expect(readSkillActiveState(tempDir, 'session-1').skill_name).toBe('omc-setup');
        });
        it('re-invocation resets reinforcement count', () => {
            writeSkillActiveState(tempDir, 'plan', 'session-1');
            // Simulate some reinforcement checks
            checkSkillActiveState(tempDir, 'session-1');
            checkSkillActiveState(tempDir, 'session-1');
            const stateBeforeRefresh = readSkillActiveState(tempDir, 'session-1');
            expect(stateBeforeRefresh.reinforcement_count).toBe(2);
            // Re-invoke same skill
            writeSkillActiveState(tempDir, 'plan', 'session-1');
            const stateAfterRefresh = readSkillActiveState(tempDir, 'session-1');
            expect(stateAfterRefresh.reinforcement_count).toBe(0);
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
            expect(state.skill_name).toBe('plan');
            expect(state.active).toBe(true);
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
            const state = {
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
            const state = {
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
            const state = {
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
            const state = {
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
            const state = {
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
            expect(state.reinforcement_count).toBe(2);
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
            const state = readSkillActiveState(tempDir, 'session-1');
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
            expect(readSkillActiveState(tempDir, 'session-1').skill_name).toBe('omc-setup');
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
            expect(parentState.skill_name).toBe('omc-setup');
            expect(parentState.active).toBe(true);
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
    // -----------------------------------------------------------------------
    // writeSkillActiveStateCopies — dual-write invariant (spec a/b)
    // -----------------------------------------------------------------------
    describe('writeSkillActiveStateCopies — dual-write invariant (spec a/b)', () => {
        const rootFilePath = (dir) => join(dir, '.omc', 'state', 'skill-active-state.json');
        const sessionFilePath = (dir, sid) => join(dir, '.omc', 'state', 'sessions', sid, 'skill-active-state.json');
        it('writes both root and session copies on seed', () => {
            const sessionId = 'dwc-seed-01';
            const state = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'ralph', {
                session_id: sessionId,
                mode_state_path: 'ralph-state.json',
                initialized_mode: 'ralph',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: sessionFilePath(tempDir, sessionId),
            });
            writeSkillActiveStateCopies(tempDir, state, sessionId);
            expect(existsSync(rootFilePath(tempDir))).toBe(true);
            expect(existsSync(sessionFilePath(tempDir, sessionId))).toBe(true);
        });
        it('both copies contain identical slot content after seed', () => {
            const sessionId = 'dwc-parity-01';
            const state = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'autopilot', {
                session_id: sessionId,
                mode_state_path: 'autopilot-state.json',
                initialized_mode: 'autopilot',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: sessionFilePath(tempDir, sessionId),
            });
            writeSkillActiveStateCopies(tempDir, state, sessionId);
            const root = JSON.parse(readFileSync(rootFilePath(tempDir), 'utf-8'));
            const session = JSON.parse(readFileSync(sessionFilePath(tempDir, sessionId), 'utf-8'));
            expect(root.active_skills['autopilot']).toBeDefined();
            expect(session.active_skills['autopilot']).toBeDefined();
            expect(root.active_skills['autopilot']?.session_id).toBe(sessionId);
            expect(session.active_skills['autopilot']?.session_id).toBe(sessionId);
        });
        it('writes only root copy when sessionId is omitted', () => {
            const state = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'ralph', {
                session_id: 'anon',
                mode_state_path: 'ralph-state.json',
                initialized_mode: 'ralph',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: '',
            });
            writeSkillActiveStateCopies(tempDir, state);
            expect(existsSync(rootFilePath(tempDir))).toBe(true);
            expect(existsSync(join(tempDir, '.omc', 'state', 'sessions'))).toBe(false);
        });
        it('both copies reflect tombstone after markWorkflowSkillCompleted (spec b)', () => {
            const sessionId = 'dwc-tomb-01';
            const seeded = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'ralph', {
                session_id: sessionId,
                mode_state_path: 'ralph-state.json',
                initialized_mode: 'ralph',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: sessionFilePath(tempDir, sessionId),
            });
            writeSkillActiveStateCopies(tempDir, seeded, sessionId);
            const tombstoneTime = '2026-04-17T10:00:00.000Z';
            const tombstoned = markWorkflowSkillCompleted(seeded, 'ralph', tombstoneTime);
            writeSkillActiveStateCopies(tempDir, tombstoned, sessionId);
            const root = JSON.parse(readFileSync(rootFilePath(tempDir), 'utf-8'));
            const session = JSON.parse(readFileSync(sessionFilePath(tempDir, sessionId), 'utf-8'));
            expect(root.active_skills['ralph']?.completed_at).toBe(tombstoneTime);
            expect(session.active_skills['ralph']?.completed_at).toBe(tombstoneTime);
        });
        it('removes both files when all slots cleared (spec b cancel)', () => {
            const sessionId = 'dwc-cancel-01';
            const seeded = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'ralph', {
                session_id: sessionId,
                mode_state_path: 'ralph-state.json',
                initialized_mode: 'ralph',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: sessionFilePath(tempDir, sessionId),
            });
            writeSkillActiveStateCopies(tempDir, seeded, sessionId);
            expect(existsSync(rootFilePath(tempDir))).toBe(true);
            expect(existsSync(sessionFilePath(tempDir, sessionId))).toBe(true);
            const cleared = clearWorkflowSkillSlot(seeded, 'ralph');
            writeSkillActiveStateCopies(tempDir, cleared, sessionId);
            expect(existsSync(rootFilePath(tempDir))).toBe(false);
            expect(existsSync(sessionFilePath(tempDir, sessionId))).toBe(false);
        });
        it('returns true on successful dual-write', () => {
            const sessionId = 'dwc-ok-01';
            const state = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'ultrawork', {
                session_id: sessionId,
                mode_state_path: 'ultrawork-state.json',
                initialized_mode: 'ultrawork',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: sessionFilePath(tempDir, sessionId),
            });
            const result = writeSkillActiveStateCopies(tempDir, state, sessionId);
            expect(result).toBe(true);
        });
    });
    // -----------------------------------------------------------------------
    // readSkillActiveStateNormalized — v1 scalar + v2 normalization (spec a)
    // -----------------------------------------------------------------------
    describe('readSkillActiveStateNormalized — normalization and session authority', () => {
        it('returns empty v2 when no files exist', () => {
            const state = readSkillActiveStateNormalized(tempDir, 'no-session');
            expect(state.version).toBe(2);
            expect(Object.keys(state.active_skills)).toHaveLength(0);
        });
        it('normalizes v1 scalar payload into support_skill branch', () => {
            const stateDir = join(tempDir, '.omc', 'state');
            mkdirSync(stateDir, { recursive: true });
            const v1 = {
                active: true,
                skill_name: 'plan',
                session_id: 'v1-sess',
                started_at: new Date().toISOString(),
                last_checked_at: new Date().toISOString(),
                reinforcement_count: 0,
                max_reinforcements: 5,
                stale_ttl_ms: 15 * 60 * 1000,
            };
            writeFileSync(join(stateDir, 'skill-active-state.json'), JSON.stringify(v1, null, 2));
            const normalized = readSkillActiveStateNormalized(tempDir);
            expect(normalized.version).toBe(2);
            expect(normalized.support_skill?.skill_name).toBe('plan');
            expect(Object.keys(normalized.active_skills)).toHaveLength(0);
        });
        it('session copy is authoritative for session-local reads', () => {
            const sessionId = 'norm-auth-01';
            const rootDir = join(tempDir, '.omc', 'state');
            const sessionDir = join(rootDir, 'sessions', sessionId);
            mkdirSync(rootDir, { recursive: true });
            mkdirSync(sessionDir, { recursive: true });
            const rootState = {
                version: 2,
                active_skills: {
                    'autopilot': {
                        skill_name: 'autopilot',
                        started_at: '2026-01-01T00:00:00Z',
                        completed_at: null,
                        session_id: 'other-session',
                        mode_state_path: '',
                        initialized_mode: 'autopilot',
                        initialized_state_path: '',
                        initialized_session_state_path: '',
                    },
                },
            };
            const sessionState = {
                version: 2,
                active_skills: {
                    'ralph': {
                        skill_name: 'ralph',
                        started_at: '2026-01-01T00:00:00Z',
                        completed_at: null,
                        session_id: sessionId,
                        mode_state_path: '',
                        initialized_mode: 'ralph',
                        initialized_state_path: '',
                        initialized_session_state_path: '',
                    },
                },
            };
            writeFileSync(join(rootDir, 'skill-active-state.json'), JSON.stringify(rootState));
            writeFileSync(join(sessionDir, 'skill-active-state.json'), JSON.stringify(sessionState));
            const result = readSkillActiveStateNormalized(tempDir, sessionId);
            expect(result.active_skills['ralph']).toBeDefined();
            expect(result.active_skills['autopilot']).toBeUndefined();
        });
        it('returns empty state when sessionId provided but no session copy exists (no cross-session leak)', () => {
            const rootDir = join(tempDir, '.omc', 'state');
            mkdirSync(rootDir, { recursive: true });
            const rootState = {
                version: 2,
                active_skills: {
                    'ralph': {
                        skill_name: 'ralph',
                        started_at: '2026-01-01T00:00:00Z',
                        completed_at: null,
                        session_id: 'root-only',
                        mode_state_path: '',
                        initialized_mode: 'ralph',
                        initialized_state_path: '',
                        initialized_session_state_path: '',
                    },
                },
            };
            writeFileSync(join(rootDir, 'skill-active-state.json'), JSON.stringify(rootState));
            const result = readSkillActiveStateNormalized(tempDir, 'different-session');
            expect(Object.keys(result.active_skills)).toHaveLength(0);
        });
    });
    // -----------------------------------------------------------------------
    // pruneExpiredWorkflowSkillTombstones — TTL sweep (spec c)
    // -----------------------------------------------------------------------
    describe('pruneExpiredWorkflowSkillTombstones — TTL sweep (spec c)', () => {
        const makeSlot = (skillName, completedAt) => ({
            skill_name: skillName,
            started_at: '2026-04-17T00:00:00.000Z',
            completed_at: completedAt ?? null,
            session_id: 'prune-session',
            mode_state_path: `${skillName}-state.json`,
            initialized_mode: skillName,
            initialized_state_path: '',
            initialized_session_state_path: '',
        });
        it('removes tombstoned slots past TTL', () => {
            const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
            const state = {
                version: 2,
                active_skills: { 'ralph': makeSlot('ralph', past) },
            };
            const pruned = pruneExpiredWorkflowSkillTombstones(state, WORKFLOW_TOMBSTONE_TTL_MS);
            expect(pruned.active_skills['ralph']).toBeUndefined();
        });
        it('keeps tombstoned slots within TTL', () => {
            const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
            const state = {
                version: 2,
                active_skills: { 'ralph': makeSlot('ralph', recent) },
            };
            const pruned = pruneExpiredWorkflowSkillTombstones(state, WORKFLOW_TOMBSTONE_TTL_MS);
            expect(pruned.active_skills['ralph']).toBeDefined();
        });
        it('never removes live (non-tombstoned) slots', () => {
            const state = {
                version: 2,
                active_skills: { 'autopilot': makeSlot('autopilot') },
            };
            const pruned = pruneExpiredWorkflowSkillTombstones(state);
            expect(pruned.active_skills['autopilot']).toBeDefined();
        });
        it('prunes only stale tombstones, keeps fresh tombstones and live slots', () => {
            const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
            const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
            const state = {
                version: 2,
                active_skills: {
                    'ralph': makeSlot('ralph', old),
                    'autopilot': makeSlot('autopilot', fresh),
                    'ultrawork': makeSlot('ultrawork'),
                },
            };
            const pruned = pruneExpiredWorkflowSkillTombstones(state);
            expect(pruned.active_skills['ralph']).toBeUndefined();
            expect(pruned.active_skills['autopilot']).toBeDefined();
            expect(pruned.active_skills['ultrawork']).toBeDefined();
        });
        it('returns same reference when nothing changed', () => {
            const state = {
                version: 2,
                active_skills: { 'autopilot': makeSlot('autopilot') },
            };
            const pruned = pruneExpiredWorkflowSkillTombstones(state);
            expect(pruned).toBe(state);
        });
        it('keeps slot with malformed completed_at defensively', () => {
            const state = {
                version: 2,
                active_skills: { 'ralph': { ...makeSlot('ralph'), completed_at: 'not-a-date' } },
            };
            const pruned = pruneExpiredWorkflowSkillTombstones(state);
            expect(pruned.active_skills['ralph']).toBeDefined();
        });
        it('WORKFLOW_TOMBSTONE_TTL_MS equals 24 hours', () => {
            expect(WORKFLOW_TOMBSTONE_TTL_MS).toBe(24 * 60 * 60 * 1000);
        });
    });
    // -----------------------------------------------------------------------
    // resolveAuthoritativeWorkflowSkill — nested lineage (spec f)
    // -----------------------------------------------------------------------
    describe('resolveAuthoritativeWorkflowSkill — nested lineage (spec f)', () => {
        const makeSlot = (skillName, opts = {}) => ({
            skill_name: skillName,
            started_at: new Date().toISOString(),
            completed_at: null,
            session_id: 'nest-session',
            mode_state_path: `${skillName}-state.json`,
            initialized_mode: skillName,
            initialized_state_path: '',
            initialized_session_state_path: '',
            ...opts,
        });
        it('returns null when no slots', () => {
            expect(resolveAuthoritativeWorkflowSkill(emptySkillActiveStateV2())).toBeNull();
        });
        it('returns null when all slots are tombstoned', () => {
            const state = {
                version: 2,
                active_skills: {
                    'ralph': makeSlot('ralph', { completed_at: '2026-04-17T00:00:00Z' }),
                },
            };
            expect(resolveAuthoritativeWorkflowSkill(state)).toBeNull();
        });
        it('returns the single live slot', () => {
            const state = {
                version: 2,
                active_skills: { 'ralph': makeSlot('ralph') },
            };
            expect(resolveAuthoritativeWorkflowSkill(state)?.skill_name).toBe('ralph');
        });
        it('returns autopilot (outer root) while ralph (child) is live beneath it', () => {
            const autopilotStarted = new Date(Date.now() - 5000).toISOString();
            const ralphStarted = new Date().toISOString();
            const state = {
                version: 2,
                active_skills: {
                    'autopilot': makeSlot('autopilot', { started_at: autopilotStarted }),
                    'ralph': makeSlot('ralph', { parent_skill: 'autopilot', started_at: ralphStarted }),
                },
            };
            const result = resolveAuthoritativeWorkflowSkill(state);
            expect(result?.skill_name).toBe('autopilot');
        });
        it('ralph tombstone does not affect autopilot; autopilot stays authoritative', () => {
            const autopilotStarted = new Date(Date.now() - 5000).toISOString();
            const state = {
                version: 2,
                active_skills: {
                    'autopilot': makeSlot('autopilot', { started_at: autopilotStarted }),
                    'ralph': makeSlot('ralph', { parent_skill: 'autopilot', completed_at: '2026-04-17T00:00:00Z' }),
                },
            };
            const result = resolveAuthoritativeWorkflowSkill(state);
            expect(result?.skill_name).toBe('autopilot');
            expect(result?.completed_at).toBeFalsy();
        });
        it('autopilot completed_at stays unset while ralph is active beneath it (spec f invariant)', () => {
            const state = {
                version: 2,
                active_skills: {
                    'autopilot': makeSlot('autopilot'),
                    'ralph': makeSlot('ralph', { parent_skill: 'autopilot' }),
                },
            };
            expect(state.active_skills['autopilot']?.completed_at).toBeFalsy();
            expect(resolveAuthoritativeWorkflowSkill(state)?.skill_name).toBe('autopilot');
        });
    });
    // -----------------------------------------------------------------------
    // Diverged-copy reconciliation (spec d)
    // -----------------------------------------------------------------------
    describe('diverged-copy reconciliation (spec d)', () => {
        const rootFilePath = (dir) => join(dir, '.omc', 'state', 'skill-active-state.json');
        const sessionFilePath = (dir, sid) => join(dir, '.omc', 'state', 'sessions', sid, 'skill-active-state.json');
        it('session copy is authoritative when root and session copies diverge', () => {
            const sessionId = 'drift-auth-01';
            const rootDir = join(tempDir, '.omc', 'state');
            const sessionDir = join(rootDir, 'sessions', sessionId);
            mkdirSync(rootDir, { recursive: true });
            mkdirSync(sessionDir, { recursive: true });
            const baseSlot = {
                skill_name: 'ralph',
                started_at: '2026-04-17T00:00:00Z',
                completed_at: null,
                session_id: sessionId,
                mode_state_path: 'ralph-state.json',
                initialized_mode: 'ralph',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: sessionFilePath(tempDir, sessionId),
            };
            const staleRootState = { version: 2, active_skills: { 'ralph': baseSlot } };
            const freshSessionState = {
                version: 2,
                active_skills: { 'ralph': { ...baseSlot, last_confirmed_at: '2026-04-17T01:00:00Z' } },
            };
            writeFileSync(rootFilePath(tempDir), JSON.stringify(staleRootState));
            writeFileSync(sessionFilePath(tempDir, sessionId), JSON.stringify(freshSessionState));
            const result = readSkillActiveStateNormalized(tempDir, sessionId);
            expect(result.active_skills['ralph']?.last_confirmed_at).toBe('2026-04-17T01:00:00Z');
        });
        it('next writeSkillActiveStateCopies re-syncs diverged copies', () => {
            const sessionId = 'drift-resync-01';
            const rootDir = join(tempDir, '.omc', 'state');
            const sessionDir = join(rootDir, 'sessions', sessionId);
            mkdirSync(rootDir, { recursive: true });
            mkdirSync(sessionDir, { recursive: true });
            const baseSlot = {
                skill_name: 'ralph',
                started_at: '2026-04-17T00:00:00Z',
                completed_at: null,
                session_id: sessionId,
                mode_state_path: 'ralph-state.json',
                initialized_mode: 'ralph',
                initialized_state_path: rootFilePath(tempDir),
                initialized_session_state_path: sessionFilePath(tempDir, sessionId),
            };
            writeFileSync(rootFilePath(tempDir), JSON.stringify({ version: 2, active_skills: { 'ralph': baseSlot } }));
            writeFileSync(sessionFilePath(tempDir, sessionId), JSON.stringify({
                version: 2,
                active_skills: { 'ralph': { ...baseSlot, last_confirmed_at: '2026-04-17T01:00:00Z' } },
            }));
            // Next mutation: tombstone via session-authoritative read → dual-write reconciles
            const current = readSkillActiveStateNormalized(tempDir, sessionId);
            const tombstoned = markWorkflowSkillCompleted(current, 'ralph');
            writeSkillActiveStateCopies(tempDir, tombstoned, sessionId);
            const rootAfter = JSON.parse(readFileSync(rootFilePath(tempDir), 'utf-8'));
            const sessionAfter = JSON.parse(readFileSync(sessionFilePath(tempDir, sessionId), 'utf-8'));
            expect(rootAfter.active_skills['ralph']?.completed_at).toBeTruthy();
            expect(sessionAfter.active_skills['ralph']?.completed_at).toBeTruthy();
        });
    });
    // -----------------------------------------------------------------------
    // Pure workflow-slot helpers — unit tests
    // -----------------------------------------------------------------------
    describe('upsertWorkflowSkillSlot — pure helper', () => {
        it('creates a new slot with provided fields', () => {
            const state = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'ralph', {
                session_id: 's1',
                mode_state_path: 'r.json',
                initialized_mode: 'ralph',
                initialized_state_path: '',
                initialized_session_state_path: '',
            });
            expect(state.active_skills['ralph']?.skill_name).toBe('ralph');
            expect(state.active_skills['ralph']?.session_id).toBe('s1');
        });
        it('preserves started_at on re-upsert (idempotent seed)', () => {
            const seeded = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'ralph', {
                session_id: 's1',
                started_at: '2026-01-01T00:00:00Z',
                mode_state_path: 'r.json',
                initialized_mode: 'ralph',
                initialized_state_path: '',
                initialized_session_state_path: '',
            });
            const confirmed = upsertWorkflowSkillSlot(seeded, 'ralph', {
                last_confirmed_at: '2026-04-17T00:00:00Z',
            });
            expect(confirmed.active_skills['ralph']?.started_at).toBe('2026-01-01T00:00:00Z');
            expect(confirmed.active_skills['ralph']?.last_confirmed_at).toBe('2026-04-17T00:00:00Z');
        });
        it('strips oh-my-claudecode: prefix from skill name', () => {
            const state = upsertWorkflowSkillSlot(emptySkillActiveStateV2(), 'oh-my-claudecode:ralph', {
                session_id: 's1',
                mode_state_path: 'r.json',
                initialized_mode: 'ralph',
                initialized_state_path: '',
                initialized_session_state_path: '',
            });
            expect(state.active_skills['ralph']).toBeDefined();
            expect(state.active_skills['oh-my-claudecode:ralph']).toBeUndefined();
        });
        it('does not mutate the original state object', () => {
            const original = emptySkillActiveStateV2();
            upsertWorkflowSkillSlot(original, 'ralph', {
                session_id: 's1',
                mode_state_path: 'r.json',
                initialized_mode: 'ralph',
                initialized_state_path: '',
                initialized_session_state_path: '',
            });
            expect(Object.keys(original.active_skills)).toHaveLength(0);
        });
    });
    describe('markWorkflowSkillCompleted — pure helper', () => {
        it('sets completed_at to provided timestamp', () => {
            const ts = '2026-04-17T12:00:00.000Z';
            const state = {
                version: 2,
                active_skills: {
                    'ralph': {
                        skill_name: 'ralph', started_at: '2026-04-17T00:00:00Z', completed_at: null,
                        session_id: 's1', mode_state_path: '', initialized_mode: 'ralph',
                        initialized_state_path: '', initialized_session_state_path: '',
                    },
                },
            };
            const tombstoned = markWorkflowSkillCompleted(state, 'ralph', ts);
            expect(tombstoned.active_skills['ralph']?.completed_at).toBe(ts);
        });
        it('returns state unchanged when slot is absent (idempotent)', () => {
            const state = emptySkillActiveStateV2();
            const result = markWorkflowSkillCompleted(state, 'ralph');
            expect(result).toBe(state);
        });
        it('does not tombstone sibling slots', () => {
            const state = {
                version: 2,
                active_skills: {
                    'ralph': {
                        skill_name: 'ralph', started_at: '2026-04-17T00:00:00Z', completed_at: null,
                        session_id: 's1', mode_state_path: '', initialized_mode: 'ralph',
                        initialized_state_path: '', initialized_session_state_path: '',
                    },
                    'autopilot': {
                        skill_name: 'autopilot', started_at: '2026-04-17T00:00:00Z', completed_at: null,
                        session_id: 's1', mode_state_path: '', initialized_mode: 'autopilot',
                        initialized_state_path: '', initialized_session_state_path: '',
                    },
                },
            };
            const tombstoned = markWorkflowSkillCompleted(state, 'ralph');
            expect(tombstoned.active_skills['autopilot']?.completed_at).toBeFalsy();
        });
    });
    describe('clearWorkflowSkillSlot — pure helper', () => {
        it('removes the slot entirely', () => {
            const state = {
                version: 2,
                active_skills: {
                    'ralph': {
                        skill_name: 'ralph', started_at: '2026-04-17T00:00:00Z', completed_at: null,
                        session_id: 's1', mode_state_path: '', initialized_mode: 'ralph',
                        initialized_state_path: '', initialized_session_state_path: '',
                    },
                },
            };
            const cleared = clearWorkflowSkillSlot(state, 'ralph');
            expect(cleared.active_skills['ralph']).toBeUndefined();
        });
        it('is idempotent when slot is absent', () => {
            const state = emptySkillActiveStateV2();
            const result = clearWorkflowSkillSlot(state, 'ralph');
            expect(result).toBe(state);
        });
        it('does not remove sibling slots', () => {
            const state = {
                version: 2,
                active_skills: {
                    'ralph': {
                        skill_name: 'ralph', started_at: '2026-04-17T00:00:00Z', completed_at: null,
                        session_id: 's1', mode_state_path: '', initialized_mode: 'ralph',
                        initialized_state_path: '', initialized_session_state_path: '',
                    },
                    'autopilot': {
                        skill_name: 'autopilot', started_at: '2026-04-17T00:00:00Z', completed_at: null,
                        session_id: 's1', mode_state_path: '', initialized_mode: 'autopilot',
                        initialized_state_path: '', initialized_session_state_path: '',
                    },
                },
            };
            const cleared = clearWorkflowSkillSlot(state, 'ralph');
            expect(cleared.active_skills['autopilot']).toBeDefined();
        });
    });
});
//# sourceMappingURL=skill-state.test.js.map