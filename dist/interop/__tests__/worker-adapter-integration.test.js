import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { bridgeBootstrapToOmx, bridgeBootstrapToOmc, pollOmxCompletion, bridgeDoneSignalToOmx, teamConfigToOmx, omxTaskToTaskFile, taskFileToOmxTask, } from '../worker-adapter.js';
let tempDir;
beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omc-interop-test-'));
});
afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
});
function activeCtx(teamName = 'test-team') {
    return { lead: 'omc', teamName, cwd: tempDir, interopMode: 'active' };
}
function offCtx(teamName = 'test-team') {
    return { lead: 'omc', teamName, cwd: tempDir, interopMode: 'off' };
}
// ============================================================================
// Bootstrap Integration
// ============================================================================
describe('bridgeBootstrapToOmx (file I/O)', () => {
    it('writes OMX mailbox file when interopMode is active', async () => {
        const ctx = activeCtx();
        await bridgeBootstrapToOmx(ctx, 'worker-1', {
            id: '1', subject: 'Fix auth', description: 'Fix the auth module',
        });
        const mailboxPath = join(tempDir, '.omx', 'state', 'team', 'test-team', 'mailbox', 'worker-1.json');
        expect(existsSync(mailboxPath)).toBe(true);
        const content = JSON.parse(await readFile(mailboxPath, 'utf-8'));
        expect(content.worker).toBe('worker-1');
        expect(content.messages).toHaveLength(1);
        expect(content.messages[0].from_worker).toBe('omc-lead');
        expect(content.messages[0].to_worker).toBe('worker-1');
        expect(content.messages[0].body).toContain('Fix auth');
        expect(content.messages[0].body).toContain('Fix the auth module');
        expect(content.messages[0].message_id).toMatch(/^[0-9a-f-]{36}$/);
    });
    it('is a no-op when interopMode is off', async () => {
        const ctx = offCtx();
        await bridgeBootstrapToOmx(ctx, 'worker-1', {
            id: '1', subject: 'Fix auth', description: 'Fix the auth module',
        });
        const mailboxPath = join(tempDir, '.omx', 'state', 'team', 'test-team', 'mailbox', 'worker-1.json');
        expect(existsSync(mailboxPath)).toBe(false);
    });
    it('is a no-op when interopMode is observe', async () => {
        const ctx = { lead: 'omc', teamName: 'test-team', cwd: tempDir, interopMode: 'observe' };
        await bridgeBootstrapToOmx(ctx, 'worker-1', {
            id: '1', subject: 'Fix auth', description: 'Fix the auth module',
        });
        const mailboxPath = join(tempDir, '.omx', 'state', 'team', 'test-team', 'mailbox', 'worker-1.json');
        expect(existsSync(mailboxPath)).toBe(false);
    });
});
describe('bridgeBootstrapToOmc (file I/O)', () => {
    it('writes AGENTS.md overlay and inbox.md', async () => {
        const ctx = activeCtx();
        await bridgeBootstrapToOmc(ctx, 'worker-1', 'claude', {
            id: '1', subject: 'Fix auth', description: 'Fix the auth module',
        });
        const overlayPath = join(tempDir, '.omc', 'state', 'team', 'test-team', 'workers', 'worker-1', 'AGENTS.md');
        expect(existsSync(overlayPath)).toBe(true);
        const overlay = await readFile(overlayPath, 'utf-8');
        expect(overlay).toContain('Team Worker Protocol');
        expect(overlay).toContain('worker-1');
        const inboxPath = join(tempDir, '.omc', 'state', 'team', 'test-team', 'workers', 'worker-1', 'inbox.md');
        expect(existsSync(inboxPath)).toBe(true);
        const inbox = await readFile(inboxPath, 'utf-8');
        expect(inbox).toContain('Fix auth');
    });
});
// ============================================================================
// Completion Signal Integration (done.json shim)
// ============================================================================
describe('pollOmxCompletion (done.json shim)', () => {
    it('synthesizes done.json in .omc/ when OMX task is completed', async () => {
        const ctx = activeCtx();
        // Write an OMX task file that is completed
        const taskDir = join(tempDir, '.omx', 'state', 'team', 'test-team', 'tasks');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'task-1.json'), JSON.stringify({
            id: '1', subject: 'Fix bug', description: 'Fix it',
            status: 'completed', result: 'Bug fixed', created_at: '2026-02-27T00:00:00Z',
            completed_at: '2026-02-27T01:00:00Z',
        }));
        // Ensure .omc worker dir exists
        const workerDir = join(tempDir, '.omc', 'state', 'team', 'test-team', 'workers', 'worker-1');
        await mkdir(workerDir, { recursive: true });
        const signal = await pollOmxCompletion(ctx, 'worker-1', '1');
        expect(signal).not.toBeNull();
        expect(signal.taskId).toBe('1');
        expect(signal.status).toBe('completed');
        expect(signal.summary).toBe('Bug fixed');
        // Verify done.json was written to .omc/ (NOT .omx/)
        const donePath = join(tempDir, '.omc', 'state', 'team', 'test-team', 'workers', 'worker-1', 'done.json');
        expect(existsSync(donePath)).toBe(true);
        const doneContent = JSON.parse(await readFile(donePath, 'utf-8'));
        expect(doneContent.taskId).toBe('1');
        expect(doneContent.status).toBe('completed');
        // Verify NO done.json in .omx/
        const omxDonePath = join(tempDir, '.omx', 'state', 'team', 'test-team', 'workers', 'worker-1', 'done.json');
        expect(existsSync(omxDonePath)).toBe(false);
    });
    it('synthesizes done.json for failed OMX tasks', async () => {
        const ctx = activeCtx();
        const taskDir = join(tempDir, '.omx', 'state', 'team', 'test-team', 'tasks');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'task-2.json'), JSON.stringify({
            id: '2', subject: 'Deploy', description: 'Deploy to prod',
            status: 'failed', error: 'Timeout', created_at: '2026-02-27T00:00:00Z',
        }));
        const signal = await pollOmxCompletion(ctx, 'worker-1', '2');
        expect(signal).not.toBeNull();
        expect(signal.status).toBe('failed');
        expect(signal.summary).toBe('Timeout');
    });
    it('returns null for non-terminal OMX tasks', async () => {
        const ctx = activeCtx();
        const taskDir = join(tempDir, '.omx', 'state', 'team', 'test-team', 'tasks');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'task-3.json'), JSON.stringify({
            id: '3', subject: 'WIP', description: 'Still working',
            status: 'in_progress', created_at: '2026-02-27T00:00:00Z',
        }));
        const signal = await pollOmxCompletion(ctx, 'worker-1', '3');
        expect(signal).toBeNull();
    });
    it('returns null when OMX task does not exist', async () => {
        const ctx = activeCtx();
        const signal = await pollOmxCompletion(ctx, 'worker-1', '999');
        expect(signal).toBeNull();
    });
});
describe('bridgeDoneSignalToOmx (file I/O)', () => {
    it('updates OMX task file and appends event', async () => {
        const ctx = { lead: 'omx', teamName: 'test-team', cwd: tempDir, interopMode: 'active' };
        // Create OMX task file
        const taskDir = join(tempDir, '.omx', 'state', 'team', 'test-team', 'tasks');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'task-1.json'), JSON.stringify({
            id: '1', subject: 'Fix it', description: 'Fix the thing',
            status: 'in_progress', owner: 'worker-1',
            created_at: '2026-02-27T00:00:00Z',
        }));
        const doneSignal = {
            taskId: '1',
            status: 'completed',
            summary: 'Fixed successfully',
            completedAt: '2026-02-27T01:00:00Z',
        };
        await bridgeDoneSignalToOmx(ctx, 'worker-1', doneSignal);
        // Verify task file updated
        const taskContent = JSON.parse(await readFile(join(taskDir, 'task-1.json'), 'utf-8'));
        expect(taskContent.status).toBe('completed');
        expect(taskContent.result).toBe('Fixed successfully');
        expect(taskContent.completed_at).toBe('2026-02-27T01:00:00Z');
        // Verify event log appended
        const eventPath = join(tempDir, '.omx', 'state', 'team', 'test-team', 'events', 'events.ndjson');
        expect(existsSync(eventPath)).toBe(true);
        const eventLine = (await readFile(eventPath, 'utf-8')).trim();
        const event = JSON.parse(eventLine);
        expect(event.type).toBe('task_completed');
        expect(event.worker).toBe('worker-1');
        expect(event.task_id).toBe('1');
    });
    it('sets error field for failed tasks', async () => {
        const ctx = { lead: 'omx', teamName: 'test-team', cwd: tempDir, interopMode: 'active' };
        const taskDir = join(tempDir, '.omx', 'state', 'team', 'test-team', 'tasks');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'task-2.json'), JSON.stringify({
            id: '2', subject: 'Deploy', description: 'Deploy',
            status: 'in_progress', created_at: '2026-02-27T00:00:00Z',
        }));
        const doneSignal = {
            taskId: '2',
            status: 'failed',
            summary: 'Connection refused',
            completedAt: '2026-02-27T01:00:00Z',
        };
        await bridgeDoneSignalToOmx(ctx, 'worker-1', doneSignal);
        const taskContent = JSON.parse(await readFile(join(taskDir, 'task-2.json'), 'utf-8'));
        expect(taskContent.status).toBe('failed');
        expect(taskContent.error).toBe('Connection refused');
    });
});
// ============================================================================
// End-to-End Translation Round-Trip
// ============================================================================
describe('end-to-end task translation round-trip', () => {
    it('OMX task → OMC TaskFile → OMX task preserves blocked status', () => {
        const original = {
            id: '7', subject: 'Blocked task', description: 'Waiting on dep',
            status: 'blocked', blocked_by: ['3'], depends_on: ['3'],
            owner: 'worker-2', created_at: '2026-02-27T00:00:00Z',
        };
        const taskFile = omxTaskToTaskFile(original);
        expect(taskFile.status).toBe('pending'); // lossy: blocked → pending
        const recovered = taskFileToOmxTask(taskFile);
        expect(recovered.status).toBe('blocked'); // recovered via metadata
        expect(recovered.blocked_by).toEqual(['3']);
    });
    it('OMC config → OMX config preserves structure', () => {
        const omcConfig = {
            teamName: 'roundtrip-team',
            workerCount: 2,
            agentTypes: ['claude', 'gemini'],
            tasks: [{ subject: 'Task A', description: 'Do A' }],
            cwd: '/tmp',
        };
        const omxConfig = teamConfigToOmx(omcConfig);
        expect(omxConfig.name).toBe('roundtrip-team');
        expect(omxConfig.worker_count).toBe(2);
        expect(omxConfig.workers[0].role).toBe('claude');
        expect(omxConfig.workers[1].role).toBe('gemini');
    });
});
//# sourceMappingURL=worker-adapter-integration.test.js.map