import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';
function makeTempProject() {
    const tempDir = mkdtempSync(join(tmpdir(), 'team-ralplan-stop-'));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    return tempDir;
}
function writeTeamPipelineState(tempDir, sessionId, overrides = {}) {
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'team-state.json'), JSON.stringify({
        schema_version: 1,
        mode: 'team',
        active: true,
        session_id: sessionId,
        project_path: tempDir,
        phase: 'team-exec',
        phase_history: [{ phase: 'team-exec', entered_at: new Date().toISOString() }],
        iteration: 1,
        max_iterations: 25,
        artifacts: { plan_path: null, prd_path: null, verify_report_path: null },
        execution: { workers_total: 2, workers_active: 1, tasks_total: 5, tasks_completed: 2, tasks_failed: 0 },
        fix_loop: { attempt: 0, max_attempts: 3, last_failure_reason: null },
        cancel: { requested: false, requested_at: null, preserve_for_resume: false },
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        ...overrides,
    }, null, 2));
}
function writeCanonicalTeamState(tempDir, sessionId, teamName, currentPhase) {
    const teamDir = join(tempDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'manifest.json'), JSON.stringify({
        name: teamName,
        task: `${teamName} task`,
        leader: {
            session_id: sessionId,
            worker_id: 'leader-fixed',
            role: 'leader',
        },
        created_at: new Date().toISOString(),
        leader_cwd: tempDir,
        team_state_root: join(tempDir, '.omc', 'state'),
    }, null, 2));
    writeFileSync(join(teamDir, 'phase-state.json'), JSON.stringify({
        current_phase: currentPhase,
        updated_at: new Date().toISOString(),
    }, null, 2));
}
function writeRalplanState(tempDir, sessionId, overrides = {}) {
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        active: true,
        session_id: sessionId,
        current_phase: 'ralplan',
        started_at: new Date().toISOString(),
        ...overrides,
    }, null, 2));
}
function writeRalphState(tempDir, sessionId) {
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 1,
        max_iterations: 10,
        started_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        prompt: 'Test task',
        session_id: sessionId,
        project_path: tempDir,
        linked_ultrawork: false,
    }, null, 2));
}
function writeStopBreaker(tempDir, sessionId, name, count) {
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${name}-stop-breaker.json`), JSON.stringify({ count, updated_at: new Date().toISOString() }, null, 2));
}
function writeSubagentTrackingState(tempDir, agents) {
    const stateDir = join(tempDir, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
        agents,
        total_spawned: agents.length,
        total_completed: agents.filter((agent) => agent.status === 'completed').length,
        total_failed: agents.filter((agent) => agent.status === 'failed').length,
        last_updated: new Date().toISOString(),
    }, null, 2));
}
// ===========================================================================
// Team Pipeline Standalone Tests
// ===========================================================================
describe('team pipeline standalone stop enforcement', () => {
    it('blocks stop when team pipeline is active with non-terminal phase', async () => {
        const sessionId = 'session-team-block-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, { phase: 'team-exec' });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('team');
            expect(result.message).toContain('team-pipeline-continuation');
            expect(result.message).toContain('team-exec');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('blocks stop when team pipeline uses canonical current_phase state shape', async () => {
        const sessionId = 'session-team-current-phase-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, {
                phase: undefined,
                current_phase: 'team-exec',
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('team');
            expect(result.message).toContain('team-pipeline-continuation');
            expect(result.message).toContain('team-exec');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('blocks stop when canonical team state remains live after coarse state drifts away', async () => {
        const sessionId = 'session-team-canonical-fallback-1';
        const tempDir = makeTempProject();
        try {
            writeCanonicalTeamState(tempDir, sessionId, 'canonical-team', 'executing');
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('team');
            expect(result.message).toContain('team-pipeline-continuation');
            expect(result.message).toContain('team-exec');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when team pipeline uses canonical current_phase terminal state', async () => {
        const sessionId = 'session-team-current-phase-terminal-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, {
                phase: undefined,
                current_phase: 'complete',
                active: false,
                completed_at: new Date().toISOString(),
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('team');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('resets the team stop breaker when team state becomes inactive', async () => {
        const sessionId = 'session-team-inactive-breaker-reset-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, {
                phase: undefined,
                current_phase: 'complete',
                active: false,
                completed_at: new Date().toISOString(),
            });
            writeStopBreaker(tempDir, sessionId, 'team-pipeline', 20);
            const inactiveResult = await checkPersistentModes(sessionId, tempDir);
            expect(inactiveResult.shouldBlock).toBe(false);
            expect(inactiveResult.mode).toBe('team');
            writeTeamPipelineState(tempDir, sessionId, {
                current_phase: 'team-exec',
                active: true,
                completed_at: null,
            });
            const activeResult = await checkPersistentModes(sessionId, tempDir);
            expect(activeResult.shouldBlock).toBe(true);
            expect(activeResult.mode).toBe('team');
            expect(activeResult.message).toContain('1/20');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('still blocks stop when team pipeline uses legacy stage state shape', async () => {
        const sessionId = 'session-team-stage-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, {
                phase: undefined,
                stage: 'team-verify',
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('team');
            expect(result.message).toContain('team-verify');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when team pipeline phase is complete', async () => {
        const sessionId = 'session-team-complete-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, {
                phase: 'complete',
                active: false,
                completed_at: new Date().toISOString(),
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when team pipeline phase is failed', async () => {
        const sessionId = 'session-team-failed-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, {
                phase: 'failed',
                active: false,
                completed_at: new Date().toISOString(),
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when team pipeline phase is cancelled', async () => {
        const sessionId = 'session-team-cancelled-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, {
                phase: 'cancelled',
                active: false,
                completed_at: new Date().toISOString(),
            });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('respects session isolation (different session_id does not block)', async () => {
        const sessionId = 'session-team-iso-a';
        const tempDir = makeTempProject();
        try {
            // Write team state for a DIFFERENT session
            writeTeamPipelineState(tempDir, 'session-team-iso-b');
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('circuit breaker allows stop after max reinforcements', async () => {
        const sessionId = 'session-team-breaker-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, { phase: 'team-exec' });
            // Pre-set breaker count to max
            writeStopBreaker(tempDir, sessionId, 'team-pipeline', 20);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.message).toContain('CIRCUIT BREAKER');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('does not block on context-limit stops', async () => {
        const sessionId = 'session-team-ctx-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir, {
                stop_reason: 'context_limit',
            });
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('does not block on user abort', async () => {
        const sessionId = 'session-team-abort-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir, {
                user_requested: true,
            });
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('does not block on cancel-in-progress', async () => {
        const sessionId = 'session-team-cancel-1';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId);
            // Write cancel signal
            const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'cancel-signal-state.json'), JSON.stringify({
                requested_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 30000).toISOString(),
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('ralph takes priority over standalone team', async () => {
        const sessionId = 'session-team-ralph-priority-1';
        const tempDir = makeTempProject();
        try {
            // Write both ralph and team pipeline state
            writeRalphState(tempDir, sessionId);
            writeTeamPipelineState(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('ralph');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('blocks across all active team phases', async () => {
        const sessionId = 'session-team-phases-1';
        const tempDir = makeTempProject();
        try {
            const activePhases = ['team-plan', 'team-prd', 'team-exec', 'team-verify', 'team-fix'];
            for (const phase of activePhases) {
                writeTeamPipelineState(tempDir, sessionId, { phase });
                // Reset breaker between checks
                writeStopBreaker(tempDir, sessionId, 'team-pipeline', 0);
                const result = await checkPersistentModes(sessionId, tempDir);
                expect(result.shouldBlock).toBe(true);
                expect(result.mode).toBe('team');
                expect(result.message).toContain(phase);
            }
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
// ===========================================================================
// Ralplan Standalone Tests
// ===========================================================================
afterEach(() => {
    vi.useRealTimers();
});
describe('ralplan standalone stop enforcement', () => {
    it('blocks stop when ralplan state is active', async () => {
        const sessionId = 'session-ralplan-block-1';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('ralplan');
            expect(result.message).toContain('ralplan-continuation');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when ralplan state is inactive', async () => {
        const sessionId = 'session-ralplan-inactive-1';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId, { active: false });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('ignores ralplan state that is still awaiting skill confirmation', async () => {
        const sessionId = 'session-ralplan-awaiting-confirmation';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId, { awaiting_confirmation: true });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('none');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('respects session isolation', async () => {
        const sessionId = 'session-ralplan-iso-a';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, 'session-ralplan-iso-b');
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('circuit breaker allows stop after max reinforcements', async () => {
        const sessionId = 'session-ralplan-breaker-1';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            writeStopBreaker(tempDir, sessionId, 'ralplan', 30);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.message).toContain('CIRCUIT BREAKER');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('does not block on context-limit stops', async () => {
        const sessionId = 'session-ralplan-ctx-1';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir, {
                stop_reason: 'context_limit',
            });
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('does not block on user abort', async () => {
        const sessionId = 'session-ralplan-abort-1';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir, {
                user_requested: true,
            });
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('ralph takes priority over standalone ralplan', async () => {
        const sessionId = 'session-ralplan-ralph-priority-1';
        const tempDir = makeTempProject();
        try {
            writeRalphState(tempDir, sessionId);
            writeRalplanState(tempDir, sessionId);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('ralph');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when ralplan current_phase is complete', async () => {
        const sessionId = 'session-ralplan-terminal-complete';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId, { current_phase: 'complete' });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('ralplan');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when ralplan current_phase is failed', async () => {
        const sessionId = 'session-ralplan-terminal-failed';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId, { current_phase: 'failed' });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('ralplan');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop when ralplan current_phase is cancelled', async () => {
        const sessionId = 'session-ralplan-terminal-cancelled';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId, { current_phase: 'cancelled' });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('ralplan');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it.each([
        ['aborted'],
        ['terminated'],
        ['canceled'],
        ['handoff'],
    ])('allows stop when ralplan current_phase is %s', async (phase) => {
        const sessionId = `session-ralplan-terminal-${phase}`;
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId, { current_phase: phase });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('ralplan');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it.each([
        [{ current_phase: undefined, phase: 'aborted' }, 'aborted'],
        [{ current_phase: undefined, status: 'terminated' }, 'terminated'],
        [{ current_phase: undefined, phase: 'handoff:ralph' }, 'handoff:ralph'],
    ])('allows stop when ralplan terminal state is written via aliases: %s', async (overrides, _label) => {
        const sessionId = 'session-ralplan-terminal-alias';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId, overrides);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('ralplan');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('returns mode=ralplan on circuit breaker path', async () => {
        const sessionId = 'session-ralplan-breaker-mode';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            writeStopBreaker(tempDir, sessionId, 'ralplan', 30);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('ralplan');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('deactivates stale ralplan state after the circuit breaker trips so stop does not restart at 1/30', async () => {
        const sessionId = 'session-ralplan-breaker-no-restart';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            writeStopBreaker(tempDir, sessionId, 'ralplan', 30);
            const firstResult = await checkPersistentModes(sessionId, tempDir);
            expect(firstResult.shouldBlock).toBe(false);
            expect(firstResult.mode).toBe('ralplan');
            expect(firstResult.message).toContain('deactivating stale ralplan state');
            const statePath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
            const persistedState = JSON.parse(readFileSync(statePath, 'utf-8'));
            expect(persistedState.active).toBe(false);
            expect(persistedState.deactivated_reason).toBe('stop_breaker_exhausted');
            const secondResult = await checkPersistentModes(sessionId, tempDir);
            expect(secondResult.shouldBlock).toBe(false);
            expect(secondResult.mode).toBe('none');
            expect(secondResult.message).toBe('');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows orchestrator idle when ralplan is active but delegated subagents are still running', async () => {
        const sessionId = 'session-ralplan-active-subagents';
        const tempDir = makeTempProject();
        const now = new Date('2026-03-28T18:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(now);
        try {
            writeRalplanState(tempDir, sessionId);
            writeSubagentTrackingState(tempDir, [
                {
                    agent_id: 'agent-1721-active',
                    agent_type: 'explore',
                    started_at: new Date().toISOString(),
                    parent_mode: 'ralplan',
                    status: 'running',
                },
            ]);
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('ralplan');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('blocks stop when the active subagent count is stale beyond the recency window', async () => {
        const sessionId = 'session-ralplan-stale-subagent-count';
        const tempDir = makeTempProject();
        const now = new Date('2026-03-28T18:05:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(now);
        try {
            writeRalplanState(tempDir, sessionId);
            writeSubagentTrackingState(tempDir, [
                {
                    agent_id: 'agent-1930-stale',
                    agent_type: 'architect',
                    started_at: new Date(now.getTime() - 60_000).toISOString(),
                    parent_mode: 'ralplan',
                    status: 'running',
                },
            ]);
            const staleUpdatedAt = new Date(now.getTime() - 10_000).toISOString();
            const trackingPath = join(tempDir, '.omc', 'state', 'subagent-tracking.json');
            const tracking = JSON.parse(readFileSync(trackingPath, 'utf-8'));
            tracking.last_updated = staleUpdatedAt;
            writeFileSync(trackingPath, JSON.stringify(tracking, null, 2));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('ralplan');
            expect(result.message).toContain('ralplan-continuation');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('does not consume ralplan breaker budget while subagents are active', async () => {
        const sessionId = 'session-ralplan-subagent-breaker';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            writeStopBreaker(tempDir, sessionId, 'ralplan', 30);
            writeSubagentTrackingState(tempDir, [
                {
                    agent_id: 'agent-1721-breaker',
                    agent_type: 'explore',
                    started_at: new Date().toISOString(),
                    parent_mode: 'ralplan',
                    status: 'running',
                },
            ]);
            const bypassResult = await checkPersistentModes(sessionId, tempDir);
            expect(bypassResult.shouldBlock).toBe(false);
            expect(bypassResult.mode).toBe('ralplan');
            writeSubagentTrackingState(tempDir, []);
            const resumedResult = await checkPersistentModes(sessionId, tempDir);
            expect(resumedResult.shouldBlock).toBe(true);
            expect(resumedResult.mode).toBe('ralplan');
            expect(resumedResult.message).toContain('1/30');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('allows stop on cancel-in-progress', async () => {
        const sessionId = 'session-ralplan-cancel-mode';
        const tempDir = makeTempProject();
        try {
            writeRalplanState(tempDir, sessionId);
            // Write cancel signal — caught at top-level checkPersistentModes
            const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'cancel-signal-state.json'), JSON.stringify({
                requested_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 30000).toISOString(),
            }));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
// ===========================================================================
// Team Pipeline Fail-Open Tests
// ===========================================================================
describe('team pipeline fail-open behavior', () => {
    it('returns mode=team with shouldBlock=false for unknown phase', async () => {
        const sessionId = 'session-team-unknown-phase';
        const tempDir = makeTempProject();
        try {
            writeTeamPipelineState(tempDir, sessionId, { phase: 'unknown-phase' });
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('team');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('returns mode=team with shouldBlock=false for missing phase', async () => {
        const sessionId = 'session-team-no-phase';
        const tempDir = makeTempProject();
        try {
            // Write state with no phase field
            const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(join(stateDir, 'team-state.json'), JSON.stringify({
                schema_version: 1,
                mode: 'team',
                active: true,
                session_id: sessionId,
                started_at: new Date().toISOString(),
            }, null, 2));
            const result = await checkPersistentModes(sessionId, tempDir);
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('team');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=team-ralplan-stop.test.js.map