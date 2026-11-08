/**
 * Regression test for: missing heartbeat file should return fresh:false
 *
 * Bug: readWorkerHeartbeatSnapshot returned fresh:true when the heartbeat file
 * didn't exist, causing false "all workers idle" notifications.
 *
 * Fix: VAL-SPLIT-001 — missing heartbeat must return fresh:false.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { maybeNotifyLeaderAllWorkersIdle } from '../team-worker-hook.js';
describe('team-worker-hook heartbeat missing file', () => {
    let tmpDir;
    let stateDir;
    const teamName = 'test-team';
    const workerName = 'worker-1';
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'heartbeat-test-'));
        stateDir = join(tmpDir, '.omc', 'state');
        // Set up minimal team config so readTeamWorkersForIdleCheck works
        const teamDir = join(stateDir, 'team', teamName);
        mkdirSync(teamDir, { recursive: true });
        writeFileSync(join(teamDir, 'config.json'), JSON.stringify({
            workers: [{ name: workerName }],
            tmux_session: 'test-session',
            leader_pane_id: '%99',
        }));
        // Set up worker status as idle + fresh
        const workerDir = join(teamDir, 'workers', workerName);
        mkdirSync(workerDir, { recursive: true });
        writeFileSync(join(workerDir, 'status.json'), JSON.stringify({
            state: 'idle',
            updated_at: new Date().toISOString(),
        }));
        // Explicitly do NOT create heartbeat.json — this is the missing file scenario
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });
    it('should NOT send all-workers-idle notification when heartbeat file is missing', async () => {
        const sendKeysCalls = [];
        const mockTmux = {
            async sendKeys(target, text) {
                sendKeysCalls.push({ target, text });
            },
        };
        await maybeNotifyLeaderAllWorkersIdle({
            cwd: tmpDir,
            stateDir,
            parsedTeamWorker: { teamName, workerName },
            tmux: mockTmux,
        });
        // With the bug (fresh:true for missing heartbeat), tmux.sendKeys would be called.
        // After the fix (fresh:false), the function should return early and NOT notify.
        expect(sendKeysCalls).toHaveLength(0);
    });
    it('should send all-workers-idle notification when heartbeat file exists and is fresh', async () => {
        // Create a fresh heartbeat file
        const workerDir = join(stateDir, 'team', teamName, 'workers', workerName);
        writeFileSync(join(workerDir, 'heartbeat.json'), JSON.stringify({
            pid: process.pid,
            last_turn_at: new Date().toISOString(),
            turn_count: 1,
            alive: true,
        }));
        const sendKeysCalls = [];
        const mockTmux = {
            async sendKeys(target, text) {
                sendKeysCalls.push({ target, text });
            },
        };
        await maybeNotifyLeaderAllWorkersIdle({
            cwd: tmpDir,
            stateDir,
            parsedTeamWorker: { teamName, workerName },
            tmux: mockTmux,
        });
        // With a fresh heartbeat file, the notification SHOULD fire
        expect(sendKeysCalls.length).toBeGreaterThan(0);
        expect(sendKeysCalls[0].text).toContain('All');
        expect(sendKeysCalls[0].text).toContain('idle');
    });
});
//# sourceMappingURL=team-worker-heartbeat.test.js.map