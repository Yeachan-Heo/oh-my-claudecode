import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeTeamApiOperation } from '../api-interop.js';
describe('team api compatibility (task + mailbox legacy formats)', () => {
    let cwd;
    const teamName = 'compat-team';
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-team-api-compat-'));
        const base = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(join(base, 'tasks'), { recursive: true });
        await mkdir(join(base, 'mailbox'), { recursive: true });
        await mkdir(join(base, 'events'), { recursive: true });
        await writeFile(join(base, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'compat',
            agent_type: 'executor',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            tmux_session: 'test:0',
            next_task_id: 2,
        }, null, 2));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    it('reads legacy tasks/1.json and writes canonical task-1.json on claim', async () => {
        const legacyTaskPath = join(cwd, '.omc', 'state', 'team', teamName, 'tasks', '1.json');
        await writeFile(legacyTaskPath, JSON.stringify({
            id: '1',
            subject: 'Compat task',
            description: 'legacy filename format',
            status: 'pending',
            owner: 'worker-1',
            created_at: new Date().toISOString(),
            version: 1,
        }, null, 2));
        const readResult = await executeTeamApiOperation('read-task', {
            team_name: teamName,
            task_id: '1',
        }, cwd);
        expect(readResult.ok).toBe(true);
        if (!readResult.ok)
            return;
        const readData = readResult.data;
        expect(readData.task?.id).toBe('1');
        const claimResult = await executeTeamApiOperation('claim-task', {
            team_name: teamName,
            task_id: '1',
            worker: 'worker-1',
        }, cwd);
        expect(claimResult.ok).toBe(true);
        const canonicalPath = join(cwd, '.omc', 'state', 'team', teamName, 'tasks', 'task-1.json');
        expect(existsSync(canonicalPath)).toBe(true);
    });
    it('reads legacy mailbox JSONL and migrates to canonical JSON on mark-notified', async () => {
        const legacyMailboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'worker-1.jsonl');
        await writeFile(legacyMailboxPath, `${JSON.stringify({
            id: 'msg-1',
            from: 'leader-fixed',
            to: 'worker-1',
            body: 'hello',
            createdAt: new Date().toISOString(),
        })}\n`, 'utf-8');
        const listResult = await executeTeamApiOperation('mailbox-list', {
            team_name: teamName,
            worker: 'worker-1',
        }, cwd);
        expect(listResult.ok).toBe(true);
        if (!listResult.ok)
            return;
        const listData = listResult.data;
        expect(listData.count).toBe(1);
        expect(listData.messages?.[0]?.message_id).toBe('msg-1');
        const markResult = await executeTeamApiOperation('mailbox-mark-notified', {
            team_name: teamName,
            worker: 'worker-1',
            message_id: 'msg-1',
        }, cwd);
        expect(markResult.ok).toBe(true);
        const canonicalMailboxPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'worker-1.json');
        expect(existsSync(canonicalMailboxPath)).toBe(true);
        const canonicalRaw = await readFile(canonicalMailboxPath, 'utf-8');
        const canonical = JSON.parse(canonicalRaw);
        expect(canonical.messages[0]?.message_id).toBe('msg-1');
        expect(typeof canonical.messages[0]?.notified_at).toBe('string');
    });
});
//# sourceMappingURL=api-interop.compatibility.test.js.map