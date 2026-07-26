import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const workerMocks = vi.hoisted(() => ({
    spawnSessionEndWorker: vi.fn(),
}));
vi.mock('../worker.js', () => ({
    spawnSessionEndWorker: workerMocks.spawnSessionEndWorker,
    processSessionEndWorker: vi.fn(),
}));
vi.mock('../../../lib/worktree-paths.js', async () => {
    const actual = await vi.importActual('../../../lib/worktree-paths.js');
    return {
        ...actual,
        resolveToWorktreeRoot: vi.fn((directory) => directory ?? process.cwd()),
    };
});
import { processSessionEnd, resolveSessionEndCleanupBudgetMs } from '../index.js';
import { readSessionEndJob } from '../cleanup-manifest.js';
describe('SessionEnd foreground manifest handoff (issue #1700)', () => {
    let tmpDir;
    let transcriptPath;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-timeout-'));
        transcriptPath = path.join(tmpDir, 'transcript.jsonl');
        fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }), 'utf-8');
        vi.clearAllMocks();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('keeps the SessionEnd manifest timeout at least 30 seconds', () => {
        const hooksJsonPath = path.resolve(__dirname, '../../../../hooks/hooks.json');
        const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
        for (const entry of hooksJson.hooks.SessionEnd) {
            for (const hook of entry.hooks) {
                expect(hook.timeout).toBeGreaterThanOrEqual(30);
            }
        }
    });
    it('returns within the foreground deadline after publishing deferred worker actions', async () => {
        const sessionId = 'timeout-test-manifest';
        const startedAt = Date.now();
        await expect(processSessionEnd({
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd: tmpDir,
            permission_mode: 'default',
            hook_event_name: 'SessionEnd',
            reason: 'clear',
        })).resolves.toEqual({ continue: true });
        expect(Date.now() - startedAt).toBeLessThanOrEqual(500);
        expect(workerMocks.spawnSessionEndWorker).toHaveBeenCalledWith({ directory: tmpDir, sessionId });
        const manifest = readSessionEndJob(tmpDir, sessionId);
        expect(manifest).toEqual(expect.objectContaining({
            sessionId,
            producers: expect.objectContaining({ core: expect.objectContaining({ state: 'sealed' }) }),
        }));
        expect(manifest?.actions.callback).toEqual(expect.objectContaining({
            class: 'best-effort',
            phase: 'deferred-best-effort',
            status: 'pending',
        }));
        expect(manifest?.actions.notification).toEqual(expect.objectContaining({
            class: 'best-effort',
            phase: 'deferred-best-effort',
            status: 'pending',
        }));
    });
    it('resolves the legacy cleanup budget environment setting compatibly', () => {
        expect(resolveSessionEndCleanupBudgetMs({})).toBe(2000);
        expect(resolveSessionEndCleanupBudgetMs({ OMC_SESSIONEND_CLEANUP_BUDGET_MS: '250' })).toBe(250);
        expect(resolveSessionEndCleanupBudgetMs({ OMC_SESSIONEND_CLEANUP_BUDGET_MS: '25000' })).toBe(10000);
        expect(resolveSessionEndCleanupBudgetMs({ OMC_SESSIONEND_CLEANUP_BUDGET_MS: 'not-a-number' })).toBe(2000);
    });
});
//# sourceMappingURL=session-end-timeout.test.js.map