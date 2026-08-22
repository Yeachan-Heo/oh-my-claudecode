/**
 * Regression tests for issue #3662: the monitor-derived worker_idle event
 * must carry observable outstanding-work metadata (undelivered directed
 * messages in the worker's mailbox).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { emitMonitorDerivedEvents, readTeamEventsByType } from '../events.js';
const TEAM = 'demo-team';
const WORKER = 'worker-1';
function seed(cwd, options = {}) {
    const stateDir = join(cwd, '.omc', 'state');
    const teamDir = join(stateDir, 'team', TEAM);
    const mailboxDir = join(teamDir, 'mailbox');
    const nowIso = new Date().toISOString();
    mkdirSync(mailboxDir, { recursive: true });
    const messages = [];
    if (options.undeliveredInbound) {
        messages.push({
            message_id: 'msg-in-1',
            from_worker: 'leader-fixed',
            to_worker: WORKER,
            body: 'Review this diff.',
            created_at: nowIso,
        });
    }
    writeFileSync(join(mailboxDir, `${WORKER}.json`), JSON.stringify({ worker: WORKER, messages }));
    if (options.undeliveredOutbound) {
        writeFileSync(join(mailboxDir, 'leader-fixed.json'), JSON.stringify({
            worker: 'leader-fixed',
            messages: [{
                    message_id: 'msg-out-1',
                    from_worker: WORKER,
                    to_worker: 'leader-fixed',
                    body: 'Review findings.',
                    created_at: nowIso,
                }],
        }));
    }
    return stateDir;
}
describe('emitMonitorDerivedEvents worker_idle outstanding metadata (issue #3662)', () => {
    let cwd;
    beforeEach(async () => {
        cwd = mkdtempSync(join(tmpdir(), 'omc-events-outstanding-'));
    });
    afterEach(() => {
        rmSync(cwd, { recursive: true, force: true });
    });
    it('includes undelivered directed-message counts on the worker_idle event', async () => {
        seed(cwd, { undeliveredInbound: true, undeliveredOutbound: true });
        await emitMonitorDerivedEvents(TEAM, [], [{ name: WORKER, alive: true, status: { state: 'idle' } }], {
            taskStatusById: {},
            workerAliveByName: { [WORKER]: true },
            workerStateByName: { [WORKER]: 'working' },
        }, cwd);
        const events = await readTeamEventsByType(TEAM, 'worker_idle', cwd);
        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event.worker).toBe(WORKER);
        expect(event.undelivered_inbound_count).toBe(1);
        expect(event.undelivered_outbound_count).toBe(1);
    });
    it('reports zero outstanding when the mailbox is empty or missing', async () => {
        seed(cwd);
        await emitMonitorDerivedEvents(TEAM, [], [{ name: WORKER, alive: true, status: { state: 'idle' } }], {
            taskStatusById: {},
            workerAliveByName: { [WORKER]: true },
            workerStateByName: { [WORKER]: 'working' },
        }, cwd);
        const events = await readTeamEventsByType(TEAM, 'worker_idle', cwd);
        expect(events).toHaveLength(1);
        expect(events[0].undelivered_inbound_count).toBe(0);
        expect(events[0].undelivered_outbound_count).toBe(0);
    });
});
//# sourceMappingURL=events.outstanding.test.js.map