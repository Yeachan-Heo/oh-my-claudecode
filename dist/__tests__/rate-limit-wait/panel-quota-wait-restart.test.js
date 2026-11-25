/**
 * The continue key of the panel quota wait cannot be taken back, so the intent to send it is saved before the key and
 * a restarted daemon never sends it twice. These tests run the daemon entry point against a real state file in a temporary
 * directory. A write that fails is simulated by making the atomic write throw, and a "restart" is a new call that loads
 * the file the earlier call left. Tmux, the clock and the provider reading are fakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const disk = vi.hoisted(() => ({ failWrites: false }));
vi.mock('../../lib/atomic-write.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        atomicWriteFileSync: (...args) => {
            if (disk.failWrites)
                throw new Error('disk full');
            return original.atomicWriteFileSync(...args);
        },
    };
});
import { runDaemonPanelQuotaPass, } from '../../features/rate-limit-wait/panel-quota-wait.js';
const H = 3600_000;
const BASE_MS = Date.parse('2026-11-16T06:00:00Z');
const ERR_1308 = 'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}';
const PANE = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 };
const READING = { body: { data: { limits: [{ unit: 3, percentage: 100, nextResetTime: BASE_MS + 2 * H }] } } };
describe('panel quota wait: a restart never sends the continue key twice', () => {
    let dir;
    let env;
    let sent;
    let afterKey;
    let tmux;
    let delivery;
    const pass = (nowMs) => runDaemonPanelQuotaPass({ stateDir: join(dir, 'daemon'), env, tmux, readQuota: async () => READING, now: () => nowMs });
    const stateOnDisk = () => JSON.parse(readFileSync(join(dir, 'daemon', 'provider-quota-panels.json'), 'utf8'));
    const journal = () => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'panel-quota-restart-'));
        disk.failWrites = false;
        sent = [];
        afterKey = () => { };
        delivery = 'delivered';
        env = {
            OMC_PANEL_QUOTA_WAIT: '1',
            OMC_PANEL_QUOTA_WAIT_MARGIN_S: '0',
            OMC_PANEL_QUOTA_WAIT_CODES: '1308',
            OMC_PANEL_QUOTA_JOURNAL: join(dir, 'journal.jsonl'),
        };
        tmux = {
            listPanes: () => [PANE],
            capture: () => ERR_1308,
            sendContinue: (pane) => {
                sent.push(pane.id);
                afterKey();
                return delivery;
            },
            providerRunning: () => true,
        };
        // The pane is detected and waits for the reset.
        await pass(BASE_MS);
        expect(stateOnDisk().panes['%7'].state).toBe('waiting_quota');
    });
    afterEach(() => {
        disk.failWrites = false;
        rmSync(dir, { recursive: true, force: true });
    });
    it('the state file fails to save after the key went out: the restart finds the intent and sends nothing', async () => {
        // The key goes out, and the save at the end of the pass fails.
        afterKey = () => { disk.failWrites = true; };
        await expect(pass(BASE_MS + 2 * H)).rejects.toThrow('disk full');
        expect(sent).toEqual(['%7']);
        expect(stateOnDisk().panes['%7'].state, 'the file does not hold the intent').toBe('resuming');
        // The daemon restarts with a working disk. The error is still on the screen and every guard would pass.
        disk.failWrites = false;
        afterKey = () => { };
        const restarted = await pass(BASE_MS + 2 * H + 60_000);
        expect(sent, 'a second continue was sent after the restart').toEqual(['%7']);
        expect(restarted?.panes['%7'].state).toBe('resumed');
        expect(stateOnDisk().panes['%7'].state).toBe('resumed');
        expect(journal().filter((row) => row.result === 'resume-unconfirmed')).toHaveLength(1);
        await pass(BASE_MS + 3 * H);
        expect(sent).toEqual(['%7']);
    });
    it('the daemon is killed right after the key: the same restart sends nothing', async () => {
        afterKey = () => { throw new Error('daemon killed'); };
        await expect(pass(BASE_MS + 2 * H)).rejects.toThrow('daemon killed');
        expect(sent).toEqual(['%7']);
        afterKey = () => { };
        await pass(BASE_MS + 2 * H + 60_000);
        expect(sent).toEqual(['%7']);
        expect(stateOnDisk().panes['%7'].state).toBe('resumed');
    });
    it('a key that may have been typed without its Enter is held on disk: a restart with a changed tail sends nothing', async () => {
        delivery = 'unconfirmed';
        const first = await pass(BASE_MS + 2 * H);
        expect(sent).toEqual(['%7']);
        expect(first?.panes['%7'].state).toBe('resumed');
        expect(stateOnDisk().panes['%7']).toMatchObject({ state: 'resumed', unconfirmed: true });
        expect(journal().filter((row) => row.result === 'resume-unconfirmed')).toHaveLength(1);
        expect(journal().filter((row) => row.result === 'resume')).toHaveLength(0);
        // A restart: the typed text changed the tail, and the settle time and the next reset have both passed.
        delivery = 'delivered';
        tmux.capture = () => `${ERR_1308}\n> continue`;
        for (let hours = 3; hours <= 9; hours += 2)
            await pass(BASE_MS + hours * H);
        expect(sent, 'a second continue was typed after the unconfirmed one').toEqual(['%7']);
        expect(stateOnDisk().panes['%7']).toMatchObject({ state: 'resumed', unconfirmed: true });
    });
    it('the intent cannot be written: no key is sent, the file still says waiting, and the next pass resumes once', async () => {
        disk.failWrites = true;
        await expect(pass(BASE_MS + 2 * H)).rejects.toThrow('disk full');
        expect(sent, 'a key went out without a saved intent').toEqual([]);
        expect(stateOnDisk().panes['%7'].state).toBe('waiting_quota');
        disk.failWrites = false;
        await pass(BASE_MS + 2 * H + 30_000);
        expect(sent).toEqual(['%7']);
        expect(stateOnDisk().panes['%7'].state).toBe('resumed');
        expect(journal().filter((row) => row.result === 'resume')).toHaveLength(1);
    });
});
//# sourceMappingURL=panel-quota-wait-restart.test.js.map