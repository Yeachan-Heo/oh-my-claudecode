/**
 * Tests for the opt-in provider quota wait of worker panels (panel-quota-wait.ts): the state transitions and their effects.
 * Offline: tmux is an injected fake (screens as data), the clock is set by the test, and the provider reading comes
 * from a loopback HTTP stub. The helpers are in panel-quota-wait-fixtures.ts.
 */
import { describe, it, expect } from 'vitest';
import { runPanelQuotaPass, paneKey } from '../../features/rate-limit-wait/panel-quota-wait.js';
import { BASE_MS, ERR_1308, ERR_1310, H, KEY_A, ON, PANE_A, PANE_B, exhausted5h, exhaustedWeek, screen, world } from './panel-quota-wait-fixtures.js';
// Every effect of the pass, in the order a state of a pane changes: the state a restart finds on disk is the last one
// that was saved (`persisted`), which the tests keep as JSON, as the daemon's state file would hold it.
describe('panel quota wait: state transitions and their effects', () => {
    function withDisk(w) {
        const disk = { events: [], saved: null, persistFails: false };
        w.deps.persist = (state) => {
            if (disk.persistFails)
                throw new Error('disk full');
            disk.saved = JSON.stringify(state);
            const entry = state.panes[KEY_A];
            disk.events.push(`persist:${entry?.state ?? 'none'}`);
        };
        const send = w.deps.sendContinue;
        w.deps.sendContinue = (pane) => {
            disk.events.push('send');
            return send(pane);
        };
        return disk;
    }
    async function waitingAtResetWithDisk() {
        const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
        const disk = withDisk(w);
        const state = { panes: {} };
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('waiting_quota');
        w.clock.now = BASE_MS + 2 * H;
        disk.events.length = 0;
        return { w, state, disk };
    }
    // Row: waiting x all guards pass -> the intent is on disk before the key
    it('the resume intent is saved before the key is sent, and the resumed state after it', async () => {
        const { w, state, disk } = await waitingAtResetWithDisk();
        const sendSeesIntent = [];
        const send = w.deps.sendContinue;
        w.deps.sendContinue = (pane) => {
            sendSeesIntent.push(String(JSON.parse(disk.saved).panes[KEY_A].state));
            return send(pane);
        };
        await runPanelQuotaPass(state, w.deps, ON);
        expect(disk.events).toEqual(['persist:resuming', 'send']);
        expect(sendSeesIntent, 'the file held the intent when the key went out').toEqual(['resuming']);
        expect(state.panes[KEY_A].state).toBe('resumed');
        expect(w.sent).toEqual(['%7']);
    });
    // Row: waiting x the intent cannot be saved -> no key, still waiting
    it('an intent that cannot be saved sends no key: the pane waits and the next pass retries', async () => {
        const { w, state, disk } = await waitingAtResetWithDisk();
        disk.persistFails = true;
        await runPanelQuotaPass(state, w.deps, ON);
        expect(w.sent).toHaveLength(0);
        expect(state.panes[KEY_A].state).toBe('waiting_quota');
        expect(w.log.some((t) => /could not be recorded/.test(t))).toBe(true);
        expect(w.journal.some((r) => r.result === 'resume')).toBe(false);
        disk.persistFails = false;
        await runPanelQuotaPass(state, w.deps, ON);
        expect(w.sent).toEqual(['%7']);
        expect(state.panes[KEY_A].state).toBe('resumed');
    });
    // Row: waiting x tmux refuses the key -> waiting again, and that is saved
    it('a key that tmux refuses puts the pane back to waiting, on disk as well', async () => {
        const { w, state, disk } = await waitingAtResetWithDisk();
        w.deps.sendContinue = (pane) => { disk.events.push('send'); w.sent.push(pane.id); return 'not_attempted'; };
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('waiting_quota');
        expect(disk.events).toEqual(['persist:resuming', 'send', 'persist:waiting_quota']);
        expect(JSON.parse(disk.saved).panes[KEY_A].state, 'a restart would not retry the resume').toBe('waiting_quota');
        expect(w.journal.some((r) => r.result === 'resume')).toBe(false);
        w.deps.sendContinue = (pane) => { w.sent.push(pane.id); return 'delivered'; };
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('resumed');
    });
    // Row: resuming (found after a restart) -> resumed, no second key
    it('a restart that finds a recorded resume sends no second key and says the delivery is unconfirmed', async () => {
        const { w, state, disk } = await waitingAtResetWithDisk();
        // The daemon is killed right after the key: the last state on disk is the intent.
        w.deps.sendContinue = (pane) => { w.sent.push(pane.id); throw new Error('daemon killed'); };
        await expect(runPanelQuotaPass(state, w.deps, ON)).rejects.toThrow('daemon killed');
        expect(w.sent).toEqual(['%7']);
        const onDisk = JSON.parse(disk.saved);
        expect(onDisk.panes[KEY_A].state).toBe('resuming');
        // The new daemon starts from the file. The error is still on the screen and every guard would pass.
        const restarted = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
        restarted.clock.now = BASE_MS + 2 * H + 60_000;
        await runPanelQuotaPass(onDisk, restarted.deps, ON);
        expect(restarted.sent, 'a second continue was sent').toHaveLength(0);
        expect(onDisk.panes[KEY_A].state).toBe('resumed');
        expect(restarted.log.some((t) => /resume was recorded before the daemon stopped/.test(t))).toBe(true);
        expect(restarted.journal.filter((r) => r.result === 'resume-unconfirmed')).toHaveLength(1);
        // Later passes leave the pane alone while its screen is unchanged.
        restarted.clock.now += 10 * 60_000;
        await runPanelQuotaPass(onDisk, restarted.deps, ON);
        expect(restarted.sent).toHaveLength(0);
        expect(restarted.journal.filter((r) => r.result === 'resume-unconfirmed')).toHaveLength(1);
    });
    it('a recorded resume is recovered even when the pane inventory cannot be read in that pass', async () => {
        const onDisk = { panes: { [KEY_A]: { key: KEY_A, pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, waits: 1, state: 'resuming', sig: 'abc', resumedAt: BASE_MS } } };
        const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: null });
        w.panes = null;
        await runPanelQuotaPass(onDisk, w.deps, ON);
        expect(onDisk.panes[KEY_A].state).toBe('resumed');
        expect(w.sent).toHaveLength(0);
    });
    // Row: waiting x the key may have been typed without its Enter -> held, never sent again, on disk as well
    it('a key whose delivery is unconfirmed is never sent again, even when the screen changes and the settle time passes', async () => {
        const { w, state, disk } = await waitingAtResetWithDisk();
        w.deps.sendContinue = (pane) => { disk.events.push('send'); w.sent.push(pane.id); return 'unconfirmed'; };
        await runPanelQuotaPass(state, w.deps, ON);
        expect(disk.events, 'the intent is saved before the key and nothing puts the pane back to waiting').toEqual(['persist:resuming', 'send']);
        expect(state.panes[KEY_A].state).toBe('resumed');
        expect(state.panes[KEY_A].unconfirmed).toBe(true);
        expect(w.journal.filter((r) => r.result === 'resume-unconfirmed')).toHaveLength(1);
        expect(w.journal.some((r) => r.result === 'resume')).toBe(false);
        expect(w.log.some((t) => /may have reached the pane only in part/.test(t))).toBe(true);
        // The typed text changes the tail; hours pass; the error is still above it. No pass sends a key.
        w.deps.sendContinue = (pane) => { w.sent.push(pane.id); return 'delivered'; };
        w.screens['%7'] = screen(`${ERR_1308}\n> continue`);
        for (let pass = 0; pass < 6; pass++) {
            w.clock.now += 40 * 60_000;
            await runPanelQuotaPass(state, w.deps, ON);
        }
        expect(w.sent, 'a second continue was typed after the unconfirmed one').toEqual(['%7']);
        expect(state.panes[KEY_A].state).toBe('resumed');
        expect(w.journal.filter((r) => r.result === 'resume-unconfirmed')).toHaveLength(1);
        expect(w.journal.some((r) => r.result === 'quota-wait' && r.attempt === 2)).toBe(false);
    });
    it('the hold of an unconfirmed key ends when the quota error is gone from the screen; a later error waits and resumes again', async () => {
        const { w, state } = await waitingAtResetWithDisk();
        w.deps.sendContinue = (pane) => { w.sent.push(pane.id); return 'unconfirmed'; };
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].unconfirmed).toBe(true);
        w.deps.sendContinue = (pane) => { w.sent.push(pane.id); return 'delivered'; };
        w.clock.now += 10 * 60_000;
        w.screens['%7'] = screen('the worker is busy again');
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].unconfirmed, 'the hold stays after the error is gone').toBeUndefined();
        expect(w.sent).toEqual(['%7']);
        w.clock.now += 10 * 60_000;
        w.screens['%7'] = screen(ERR_1308);
        w.reading.value = exhausted5h(w.clock.now + H);
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('waiting_quota');
        w.clock.now += H + 60_000;
        await runPanelQuotaPass(state, w.deps, ON);
        expect(w.sent).toEqual(['%7', '%7']);
        expect(state.panes[KEY_A].state).toBe('resumed');
    });
    it('a restart that finds a recorded resume holds the pane too: a changed tail and many passes send nothing', async () => {
        const onDisk = { panes: { [KEY_A]: { key: KEY_A, pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, waits: 1, state: 'resuming', sig: 'abc', resumedAt: BASE_MS } } };
        const w = world({ panes: [PANE_A], screens: { '%7': screen(`${ERR_1308}\n> continue`) }, readingValue: exhausted5h(BASE_MS + H) });
        w.clock.now = BASE_MS + 2 * H;
        for (let pass = 0; pass < 5; pass++) {
            await runPanelQuotaPass(onDisk, w.deps, ON);
            w.clock.now += 30 * 60_000;
        }
        expect(w.sent).toHaveLength(0);
        expect(onDisk.panes[KEY_A].unconfirmed).toBe(true);
        expect(w.journal.filter((r) => r.result === 'resume-unconfirmed')).toHaveLength(1);
    });
    it('a pane that disappears while it is held loses its entry, and the hold with it', async () => {
        const { w, state } = await waitingAtResetWithDisk();
        w.deps.sendContinue = () => 'unconfirmed';
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].unconfirmed).toBe(true);
        w.panes = [];
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A]).toBeUndefined();
    });
    // Row: resumed or quota-ended x a settled screen without a quota error -> the baseline is cleared
    it('after a resume, a clear screen ends the event: the same error rendered later is a new wait', async () => {
        const { w, state } = await waitingAtResetWithDisk();
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('resumed');
        expect(w.sent).toEqual(['%7']);
        // The identical screen is the old event.
        w.clock.now += 60_000;
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('resumed');
        // The provider works again: a clear screen.
        w.screens['%7'] = screen('working on the task');
        w.clock.now += 60_000;
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].sig, 'the baseline of the last event was kept').toBeNull();
        expect(state.panes[KEY_A].state).toBe('resumed');
        // The same quota error, with the same 15-line tail as the first event, is a new event.
        w.screens['%7'] = screen(ERR_1308);
        w.reading.value = exhausted5h(w.clock.now + H);
        w.clock.now += 60_000;
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('waiting_quota');
        expect(state.panes[KEY_A].waits).toBe(2);
        expect(w.journal.filter((r) => r.result === 'quota-wait')).toHaveLength(2);
    });
    it('after an ended wait, a clear screen ends the event: the same error rendered later is decided again', async () => {
        const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1310) }, readingValue: null });
        const state = { panes: {} };
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('quota-ended');
        expect(w.journal.filter((r) => r.result === 'end')).toHaveLength(1);
        // The same screen is the old event: no second row.
        await runPanelQuotaPass(state, w.deps, ON);
        expect(w.journal.filter((r) => r.result === 'end')).toHaveLength(1);
        w.screens['%7'] = screen('the user fixed the account');
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].sig).toBeNull();
        w.screens['%7'] = screen(ERR_1310);
        await runPanelQuotaPass(state, w.deps, ON);
        expect(w.journal.filter((r) => r.result === 'end'), 'the new event was suppressed').toHaveLength(2);
    });
    // Row: waiting x the error is gone from the screen at reset time -> resumed without a key
    it('an error that is gone at reset time ends the wait without a key: resumed, nothing journaled as a resume', async () => {
        const { w, state, disk } = await waitingAtResetWithDisk();
        w.screens['%7'] = screen('the provider continued by itself');
        await runPanelQuotaPass(state, w.deps, ON);
        expect(w.sent).toHaveLength(0);
        expect(state.panes[KEY_A].state).toBe('resumed');
        expect(w.log.some((t) => /no quota error on screen at reset time/.test(t))).toBe(true);
        expect(w.journal.some((r) => r.result === 'resume')).toBe(false);
        expect(disk.events, 'an intent was saved for a key that is not sent').toEqual([]);
    });
    // Row: resumed x a new error whose reading runs out of the pass time -> nothing is recorded, the next pass sees it again
    it('a new error that a pass ran out of time on is not taken for an old event by the next pass', async () => {
        const { w, state } = await waitingAtResetWithDisk();
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state).toBe('resumed');
        const baseline = state.panes[KEY_A].sig;
        // The provider fails again with a different screen; the reading does not come back in time.
        w.screens['%7'] = screen(ERR_1308, 3);
        w.clock.now += 60_000;
        w.deps.readQuota = () => new Promise(() => { });
        await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.1' });
        expect(state.panes[KEY_A].state).toBe('resumed');
        expect(state.panes[KEY_A].sig, 'the unhandled event was recorded as seen').toBe(baseline);
        // The next pass reads in time and waits for the reset of the new event.
        w.deps.readQuota = async () => exhausted5h(w.clock.now + H);
        w.clock.now += 60_000;
        await runPanelQuotaPass(state, w.deps, ON);
        expect(state.panes[KEY_A].state, 'the event was suppressed after the pass that ran out of time').toBe('waiting_quota');
        expect(state.panes[KEY_A].waits).toBe(2);
    });
    // Row: none x a configured end code -> quota-ended in this pass, whatever the reading does
    it('an end code is decided although the reading never answers: one pass ends the wait, the next makes no reading', async () => {
        const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1310) }, readingValue: null });
        let reads = 0;
        w.deps.readQuota = () => { reads++; return new Promise(() => { }); };
        const state = { panes: {} };
        await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.1' });
        expect(state.panes[KEY_A].state, 'the end code waited for the reading and was not decided').toBe('quota-ended');
        const end = w.journal.find((r) => r.result === 'end');
        expect(end.class).toBe('quota');
        expect(end.reset_ms, 'the date is unknown when the reading did not come').toBeNull();
        expect(w.log.some((t) => /wait ends with class quota/.test(t) && /reset unknown/.test(t))).toBe(true);
        expect(w.log.filter((t) => /time limit/.test(t))).toHaveLength(1);
        expect(w.sent).toHaveLength(0);
        await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.1' });
        expect(reads, 'the ended pane asked for the reading again').toBe(1);
        expect(w.journal.filter((r) => r.result === 'end')).toHaveLength(1);
    });
    it('an end code with a reading in time keeps the reset date for the coordinator', async () => {
        const reset = BASE_MS + 3 * 24 * H;
        const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1310) }, readingValue: exhaustedWeek(reset) });
        const state = { panes: {} };
        await runPanelQuotaPass(state, w.deps, ON);
        const end = w.journal.find((r) => r.result === 'end');
        expect(end.reset_ms).toBe(reset);
        expect(w.log.some((t) => t.includes(new Date(reset).toISOString()))).toBe(true);
    });
    it('an end code on a pane with no time left in the pass is still decided, and the pass stops', async () => {
        const w = world({ panes: [PANE_A, PANE_B], screens: { '%7': screen(ERR_1310), '%8': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
        let ticks = 0;
        // The start of the pass and the check at the top of the loop see time left; every later look is past the limit.
        w.deps.monotonic = () => (ticks++ < 2 ? 0 : 10_000);
        const state = { panes: {} };
        await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '1' });
        expect(state.panes[KEY_A]?.state, 'the pane with the end code was left undecided').toBe('quota-ended');
        expect(state.panes[paneKey(PANE_B)], 'the pass went on after its time ran out').toBeUndefined();
    });
    // Rows without an effect outside the state: a retry changes nothing that a restart could repeat.
    it('a restart after a pass that saved nothing repeats only what has no irreversible effect: the same wait is detected again', async () => {
        const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
        const lost = { panes: {} };
        await runPanelQuotaPass(lost, w.deps, ON);
        const restarted = { panes: {} };
        await runPanelQuotaPass(restarted, w.deps, ON);
        expect(restarted.panes[KEY_A].state).toBe('waiting_quota');
        expect(w.sent).toHaveLength(0);
    });
});
//# sourceMappingURL=panel-quota-wait-transitions.test.js.map