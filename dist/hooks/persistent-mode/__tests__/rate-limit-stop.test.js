/**
 * Integration tests for stop-guard bypasses in checkPersistentModes.
 *
 * Fixes:
 * - #777: rate-limit stop should not re-enter persistent continuation
 * - #2693: ScheduleWakeup / scheduled resume should not re-enter stale
 *   persistent continuation or inject cancel guidance ahead of scheduled work
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';
describe('persistent-mode rate-limit stop guard (fix #777)', () => {
    function makeRalphWorktree(sessionId) {
        const tempDir = mkdtempSync(join(tmpdir(), 'ralph-rate-limit-'));
        execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
        const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({
            active: true,
            iteration: 3,
            max_iterations: 10,
            started_at: new Date().toISOString(),
            prompt: 'Finish the task',
            session_id: sessionId,
            project_path: tempDir,
            linked_ultrawork: false,
        }, null, 2));
        return tempDir;
    }
    const rateLimitReasons = [
        'rate_limit',
        'rate_limited',
        'too_many_requests',
        '429',
        'quota_exceeded',
        'overloaded',
        'api_rate_limit_exceeded',
    ];
    const authenticationReasons = [
        'authentication_error',
        'unauthorized',
        '401',
        '403',
        'token_expired',
        'oauth_expired',
    ];
    const scheduledWakeupReasons = [
        'ScheduleWakeup',
        'scheduled_task',
        'scheduled_resume',
        'loop_resume',
    ];
    for (const reason of rateLimitReasons) {
        it(`should NOT block stop when stop_reason is "${reason}"`, async () => {
            const sessionId = `session-777-${reason.replace(/[^a-z0-9]/g, '-')}`;
            const tempDir = makeRalphWorktree(sessionId);
            try {
                const result = await checkPersistentModes(sessionId, tempDir, { stop_reason: reason });
                expect(result.shouldBlock).toBe(false);
                expect(result.mode).toBe('none');
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    }
    for (const reason of authenticationReasons) {
        it(`should NOT block stop when stop_reason is auth-related ("${reason}")`, async () => {
            const sessionId = `session-1308-${reason.replace(/[^a-z0-9]/g, '-')}`;
            const tempDir = makeRalphWorktree(sessionId);
            try {
                const result = await checkPersistentModes(sessionId, tempDir, { stop_reason: reason });
                expect(result.shouldBlock).toBe(false);
                expect(result.mode).toBe('none');
                expect(result.message).toMatch(/authentication/i);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    }
    for (const reason of scheduledWakeupReasons) {
        it(`should NOT block stop when stop_reason is scheduled wakeup-related ("${reason}")`, async () => {
            const sessionId = `session-2693-${reason.replace(/[^a-z0-9]/gi, '-')}`;
            const tempDir = makeRalphWorktree(sessionId);
            try {
                const result = await checkPersistentModes(sessionId, tempDir, { stop_reason: reason });
                expect(result.shouldBlock).toBe(false);
                expect(result.mode).toBe('none');
                expect(result.message).toBe('');
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    }
    it('should NOT block stop when ScheduleWakeup arrives as tool_name', async () => {
        const sessionId = 'session-2693-tool-name';
        const tempDir = makeRalphWorktree(sessionId);
        try {
            const result = await checkPersistentModes(sessionId, tempDir, { tool_name: 'ScheduleWakeup', stop_reason: 'end_turn' });
            expect(result.shouldBlock).toBe(false);
            expect(result.mode).toBe('none');
            expect(result.message).toBe('');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('should still block stop for active ralph with no rate-limit context', async () => {
        const sessionId = 'session-777-no-rate-limit';
        const tempDir = makeRalphWorktree(sessionId);
        try {
            const result = await checkPersistentModes(sessionId, tempDir, {});
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('ralph');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('should still block stop for active ralph when stop_reason is "end_turn"', async () => {
        const sessionId = 'session-777-end-turn';
        const tempDir = makeRalphWorktree(sessionId);
        try {
            const result = await checkPersistentModes(sessionId, tempDir, { stop_reason: 'end_turn' });
            expect(result.shouldBlock).toBe(true);
            expect(result.mode).toBe('ralph');
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('rate-limit pause message should mention rate limit', async () => {
        const sessionId = 'session-777-message';
        const tempDir = makeRalphWorktree(sessionId);
        try {
            const result = await checkPersistentModes(sessionId, tempDir, { stop_reason: 'rate_limit' });
            expect(result.shouldBlock).toBe(false);
            expect(result.message).toMatch(/rate.limit/i);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=rate-limit-stop.test.js.map