import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { formatAutopilotRuntimeInsight } from '../runtime-insight.js';
import { writeHudState } from '../../../hud/state.js';
function writeJson(filePath, value) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}
describe('formatAutopilotRuntimeInsight', () => {
    let cwd;
    beforeEach(() => {
        cwd = mkdtempSync(join(process.cwd(), '.tmp-runtime-insight-'));
    });
    afterEach(() => {
        rmSync(cwd, { recursive: true, force: true });
    });
    it('limits team blocker scans to teams owned by the active session', () => {
        writeJson(join(cwd, '.omc/state/team/session-a-team/manifest.json'), {
            schema_version: 2,
            name: 'session-a-team',
            task: 'session-a task',
            leader: { session_id: 'session-A', worker_id: 'leader-a', role: 'leader' },
            created_at: new Date().toISOString(),
        });
        writeJson(join(cwd, '.omc/state/team/session-a-team/tasks/task-1.json'), {
            id: '1',
            subject: 'task 1',
            description: 'broken dependency',
            status: 'pending',
            depends_on: ['999'],
            created_at: new Date().toISOString(),
        });
        writeJson(join(cwd, '.omc/state/team/session-a-team/workers/worker-1/status.json'), {
            state: 'blocked',
            reason: 'waiting on scoped issue',
            updated_at: new Date().toISOString(),
        });
        writeJson(join(cwd, '.omc/state/team/session-b-team/manifest.json'), {
            schema_version: 2,
            name: 'session-b-team',
            task: 'session-b task',
            leader: { session_id: 'session-B', worker_id: 'leader-b', role: 'leader' },
            created_at: new Date().toISOString(),
        });
        writeJson(join(cwd, '.omc/state/team/session-b-team/tasks/task-7.json'), {
            id: '7',
            subject: 'task 7',
            description: 'foreign dependency',
            status: 'pending',
            depends_on: ['404'],
            created_at: new Date().toISOString(),
        });
        writeJson(join(cwd, '.omc/state/team/session-b-team/workers/worker-9/status.json'), {
            state: 'failed',
            reason: 'foreign failure',
            updated_at: new Date().toISOString(),
        });
        writeHudState({
            timestamp: new Date().toISOString(),
            backgroundTasks: [
                {
                    id: 'bg-1',
                    description: 'verify scoped runtime insight',
                    status: 'running',
                    startedAt: new Date().toISOString(),
                    agentType: 'executor',
                },
            ],
        }, cwd, 'session-A');
        const insight = formatAutopilotRuntimeInsight(cwd, 'session-A');
        expect(insight).toContain('[session-a-team] task-1 depends on missing task ids [999]');
        expect(insight).toContain('[session-a-team] worker-1 is blocked: waiting on scoped issue');
        expect(insight).not.toContain('session-b-team');
        expect(insight).not.toContain('foreign failure');
        expect(insight).toContain('Live progress:');
        expect(insight).toContain('running (executor): verify scoped runtime insight');
    });
    it('keeps legacy workspace-wide scanning when no session id is provided', () => {
        writeJson(join(cwd, '.omc/state/team/team-a/tasks/task-1.json'), {
            id: '1',
            subject: 'task 1',
            description: 'missing dep',
            status: 'pending',
            depends_on: ['2'],
            created_at: new Date().toISOString(),
        });
        writeJson(join(cwd, '.omc/state/team/team-b/workers/worker-2/status.json'), {
            state: 'failed',
            reason: 'global failure',
            updated_at: new Date().toISOString(),
        });
        const insight = formatAutopilotRuntimeInsight(cwd);
        expect(insight).toContain('[team-a] task-1 depends on missing task ids [2]');
        expect(insight).toContain('[team-b] worker-2 is failed: global failure');
    });
});
//# sourceMappingURL=runtime-insight.test.js.map