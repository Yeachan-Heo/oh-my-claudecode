import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkWatchdogFailedMarker, getTerminalStatus, writeResultArtifact, } from '../runtime-cli.js';
describe('runtime-cli terminal status helper', () => {
    it('returns null when there is still active work', () => {
        expect(getTerminalStatus({ pending: 1, inProgress: 0, completed: 0, failed: 0 }, 1)).toBeNull();
    });
    it('returns null when terminal counts do not match expected task count', () => {
        expect(getTerminalStatus({ pending: 0, inProgress: 0, completed: 1, failed: 0 }, 2)).toBeNull();
    });
    it('returns failed for terminal snapshots with any failed task', () => {
        expect(getTerminalStatus({ pending: 0, inProgress: 0, completed: 1, failed: 1 }, 2)).toBe('failed');
    });
    it('returns completed for terminal snapshots with zero failed tasks', () => {
        expect(getTerminalStatus({ pending: 0, inProgress: 0, completed: 2, failed: 0 }, 2)).toBe('completed');
    });
});
describe('runtime-cli watchdog marker helper', () => {
    it('continues when marker file does not exist', async () => {
        const stateRoot = mkdtempSync(join(tmpdir(), 'runtime-cli-watchdog-none-'));
        try {
            const result = await checkWatchdogFailedMarker(stateRoot, Date.now());
            expect(result.failed).toBe(false);
        }
        finally {
            rmSync(stateRoot, { recursive: true, force: true });
        }
    });
    it('fails fast when marker timestamp is current/fresh', async () => {
        const stateRoot = mkdtempSync(join(tmpdir(), 'runtime-cli-watchdog-fresh-'));
        try {
            const startTime = Date.now();
            writeFileSync(join(stateRoot, 'watchdog-failed.json'), JSON.stringify({ failedAt: startTime + 1_000 }), 'utf-8');
            const result = await checkWatchdogFailedMarker(stateRoot, startTime);
            expect(result.failed).toBe(true);
            expect(result.reason).toContain('Watchdog marked team failed');
        }
        finally {
            rmSync(stateRoot, { recursive: true, force: true });
        }
    });
    it('treats stale marker as non-fatal and unlinks it best-effort', async () => {
        const stateRoot = mkdtempSync(join(tmpdir(), 'runtime-cli-watchdog-stale-'));
        const markerPath = join(stateRoot, 'watchdog-failed.json');
        try {
            const startTime = Date.now();
            writeFileSync(markerPath, JSON.stringify({ failedAt: new Date(startTime - 10_000).toISOString() }), 'utf-8');
            const result = await checkWatchdogFailedMarker(stateRoot, startTime);
            expect(result.failed).toBe(false);
            expect(existsSync(markerPath)).toBe(false);
        }
        finally {
            rmSync(stateRoot, { recursive: true, force: true });
        }
    });
    it('fails fast when marker is invalid JSON', async () => {
        const stateRoot = mkdtempSync(join(tmpdir(), 'runtime-cli-watchdog-badjson-'));
        try {
            writeFileSync(join(stateRoot, 'watchdog-failed.json'), '{bad-json', 'utf-8');
            const result = await checkWatchdogFailedMarker(stateRoot, Date.now());
            expect(result.failed).toBe(true);
            expect(result.reason).toContain('Failed to parse watchdog marker');
        }
        finally {
            rmSync(stateRoot, { recursive: true, force: true });
        }
    });
    it('fails fast when marker failedAt is not parseable', async () => {
        const stateRoot = mkdtempSync(join(tmpdir(), 'runtime-cli-watchdog-invalid-failedat-'));
        try {
            writeFileSync(join(stateRoot, 'watchdog-failed.json'), JSON.stringify({ failedAt: { nested: true } }), 'utf-8');
            const result = await checkWatchdogFailedMarker(stateRoot, Date.now());
            expect(result.failed).toBe(true);
            expect(result.reason).toContain('Invalid watchdog marker');
        }
        finally {
            rmSync(stateRoot, { recursive: true, force: true });
        }
    });
    it('accepts numeric-string failedAt markers', async () => {
        const stateRoot = mkdtempSync(join(tmpdir(), 'runtime-cli-watchdog-numeric-string-'));
        try {
            const startTime = Date.now();
            writeFileSync(join(stateRoot, 'watchdog-failed.json'), JSON.stringify({ failedAt: String(startTime + 5_000) }), 'utf-8');
            const result = await checkWatchdogFailedMarker(stateRoot, startTime);
            expect(result.failed).toBe(true);
            expect(result.reason).toContain('Watchdog marked team failed');
        }
        finally {
            rmSync(stateRoot, { recursive: true, force: true });
        }
    });
});
describe('runtime-cli result artifact writer', () => {
    it('writes result artifact via tmp+rename with required fields', async () => {
        const jobsDir = mkdtempSync(join(tmpdir(), 'runtime-cli-artifact-'));
        const jobId = 'job-123';
        const finishedAt = '2026-03-02T12:00:00.000Z';
        try {
            await writeResultArtifact({
                status: 'completed',
                teamName: 'team-a',
                taskResults: [{ taskId: '1', status: 'completed', summary: 'ok' }],
                duration: 1.25,
                workerCount: 2,
            }, finishedAt, jobId, jobsDir);
            const resultPath = join(jobsDir, `${jobId}-result.json`);
            const tmpPath = `${resultPath}.tmp`;
            expect(existsSync(resultPath)).toBe(true);
            expect(existsSync(tmpPath)).toBe(false);
            const payload = JSON.parse(readFileSync(resultPath, 'utf-8'));
            expect(payload.status).toBe('completed');
            expect(payload.teamName).toBe('team-a');
            expect(payload.duration).toBe(1.25);
            expect(payload.workerCount).toBe(2);
            expect(payload.finishedAt).toBe(finishedAt);
            expect(Array.isArray(payload.taskResults)).toBe(true);
        }
        finally {
            rmSync(jobsDir, { recursive: true, force: true });
        }
    });
    it('no-ops when job id or jobs dir is missing', async () => {
        const jobsDir = mkdtempSync(join(tmpdir(), 'runtime-cli-artifact-noop-'));
        try {
            await writeResultArtifact({
                status: 'failed',
                teamName: 'team-b',
                taskResults: [],
                duration: 0.1,
                workerCount: 1,
            }, '2026-03-02T12:00:00.000Z', undefined, jobsDir);
            expect(existsSync(join(jobsDir, 'undefined-result.json'))).toBe(false);
            expect(readdirSync(jobsDir)).toEqual([]);
        }
        finally {
            rmSync(jobsDir, { recursive: true, force: true });
        }
    });
    it('no-ops when jobs dir is missing even if job id is provided', async () => {
        const jobsDir = mkdtempSync(join(tmpdir(), 'runtime-cli-artifact-missing-dir-'));
        try {
            await writeResultArtifact({
                status: 'completed',
                teamName: 'team-c',
                taskResults: [{ taskId: '1', status: 'completed', summary: 'ok' }],
                duration: 0.2,
                workerCount: 1,
            }, '2026-03-02T12:00:00.000Z', 'job-999', undefined);
            expect(readdirSync(jobsDir)).toEqual([]);
        }
        finally {
            rmSync(jobsDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=runtime-cli.test.js.map