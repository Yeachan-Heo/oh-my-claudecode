/**
 * Fairness of the pass budget in panel-quota-wait.ts. One time limit is shared by every pane of a pass, and no pane may
 * keep another one from being reached, whether the panes wait for a reset or show a new error.
 *
 * Offline and deterministic: tmux is a fake whose slow capture advances a counter that serves as the monotonic clock, so
 * there are no real timers and no sleeping. A "slow" pane is one whose capture takes longer than the limit of the pass.
 */
import { describe, it, expect } from 'vitest';
import {
  paneKey,
  runPanelQuotaPass,
  type PanelEntry,
  type PanelEnv,
  type PanelState,
  type PanePoint,
  type QuotaReading,
} from '../../features/rate-limit-wait/panel-quota-wait.js';

const BASE_MS = Date.parse('2026-11-16T06:00:00Z');
const HOUR_MS = 3600_000;
const ERROR_LINE = 'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}';
const SLOW_CAPTURE_MS = 5_000; // the real capture adapter waits up to this long
const ENV: PanelEnv = {
  OMC_PANEL_QUOTA_WAIT: '1',
  OMC_PANEL_QUOTA_WAIT_MARGIN_S: '0',
  OMC_PANEL_QUOTA_WAIT_CODES: '1308',
  OMC_PANEL_QUOTA_END_CODES: '1310',
  OMC_PANEL_QUOTA_PASS_LIMIT_S: '3', // shorter than one slow capture
};

function paneAt(n: number): PanePoint {
  return { id: `%${n}`, session: 'omc-team-budget', windowIndex: 0, paneIndex: n };
}

function waitingEntry(pane: PanePoint, untilMs: number): PanelEntry {
  return {
    key: paneKey(pane),
    pane: pane.id,
    session: pane.session,
    windowIndex: pane.windowIndex,
    paneIndex: pane.paneIndex,
    waits: 1,
    state: 'waiting_quota',
    untilMs,
    resetMs: untilMs,
    sig: null,
  };
}

interface Rig {
  state: PanelState;
  /** Wall clock, set by the test. */
  clock: { now: number };
  /** Ids of the panes whose capture is slow. */
  slow: Set<string>;
  captured: string[];
  /** Ids of the panes whose provider state was asked for. */
  providerChecked: string[];
  sent: string[];
  log: string[];
  pass(): Promise<void>;
}

function rig(panes: PanePoint[], state: PanelState = { panes: {} }, env: PanelEnv = ENV): Rig {
  const clock = { now: BASE_MS };
  let monotonic = 0;
  const r: Rig = { state, clock, slow: new Set(), captured: [], providerChecked: [], sent: [], log: [], pass: async () => {} };
  const reading: QuotaReading = { body: { data: { limits: [{ unit: 3, percentage: 100, nextResetTime: BASE_MS + HOUR_MS }] } } };
  r.pass = async () => {
    r.captured.length = 0;
    r.providerChecked.length = 0;
    r.sent.length = 0;
    await runPanelQuotaPass(
      state,
      {
        now: () => clock.now,
        monotonic: () => monotonic,
        listPanes: () => panes,
        capture: (pane) => {
          r.captured.push(pane.id);
          if (r.slow.has(pane.id)) monotonic += SLOW_CAPTURE_MS;
          return ERROR_LINE;
        },
        sendContinue: (pane) => { r.sent.push(pane.id); return 'delivered'; },
        providerRunning: (pane) => { r.providerChecked.push(pane.id); return true; },
        readQuota: async () => reading,
        log: (text) => { r.log.push(text); },
        journal: () => {},
      },
      env,
    );
  };
  return r;
}

describe('panel quota wait: the budget of a pass is shared fairly', () => {
  it('a wait whose reset has not come is never captured, however slow its pane is: the due wait after it resumes in the same pass', async () => {
    const [first, second] = [paneAt(1), paneAt(2)];
    const r = rig([first, second], {
      panes: { [paneKey(first)]: waitingEntry(first, BASE_MS + HOUR_MS), [paneKey(second)]: waitingEntry(second, BASE_MS) },
    });
    r.slow.add(first.id);
    await r.pass();
    expect(r.captured).toEqual(['%2']);
    expect(r.sent).toEqual(['%2']);
    expect(r.log.some((text) => /time limit/.test(text))).toBe(false);
    expect(r.state.cursor).toBeUndefined();
  });

  it('a due wait whose capture takes longer than the pass limit is tried again after the wait behind it, which resumes in the next pass', async () => {
    const [slow, other] = [paneAt(1), paneAt(2)];
    const r = rig([slow, other], {
      panes: { [paneKey(slow)]: waitingEntry(slow, BASE_MS), [paneKey(other)]: waitingEntry(other, BASE_MS) },
    });
    r.slow.add(slow.id);

    await r.pass();
    expect(r.captured, 'the slow pane used up the pass').toEqual(['%1']);
    expect(r.providerChecked, 'no tmux call after the limit').toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.state.cursor).toBe(paneKey(other));

    await r.pass();
    expect(r.captured[0], 'the pane that was not reached is the first one now').toBe('%2');
    expect(r.sent).toEqual(['%2']);
    expect(r.state.panes[paneKey(other)].state).toBe('resumed');
    expect(r.state.panes[paneKey(slow)].state, 'the slow pane keeps its wait and is tried again').toBe('waiting_quota');
    expect(r.captured, 'and it is tried after the pane that was not reached').toEqual(['%2', '%1']);
  });

  it('over many passes a slow due wait never keeps a due wait and a new error from being served, and none is served twice', async () => {
    const panes = [paneAt(1), paneAt(2), paneAt(3), paneAt(4)];
    const [slowA, slowB, fresh, due] = panes;
    const r = rig(panes, {
      panes: { [paneKey(slowA)]: waitingEntry(slowA, BASE_MS), [paneKey(slowB)]: waitingEntry(slowB, BASE_MS), [paneKey(due)]: waitingEntry(due, BASE_MS) },
    });
    r.slow.add(slowA.id);
    r.slow.add(slowB.id);
    const sentTotal: string[] = [];
    const triedSlow = new Set<string>();
    let freshWaitingAt = 0;
    for (let passNumber = 1; passNumber <= 8; passNumber++) {
      await r.pass();
      sentTotal.push(...r.sent);
      for (const id of r.captured) if (id === slowA.id || id === slowB.id) triedSlow.add(id);
      if (freshWaitingAt === 0 && r.state.panes[paneKey(fresh)]?.state === 'waiting_quota') freshWaitingAt = passNumber;
      // Once the new error is waiting, its reset comes.
      if (freshWaitingAt > 0) r.clock.now = BASE_MS + HOUR_MS;
    }
    expect(freshWaitingAt, 'the new error was recorded within the number of slow panes plus one').toBeGreaterThan(0);
    expect(freshWaitingAt).toBeLessThanOrEqual(3);
    expect(sentTotal.filter((id) => id === due.id), 'the due wait resumed once').toHaveLength(1);
    expect(sentTotal.filter((id) => id === fresh.id), 'the new error resumed once, after its reset').toHaveLength(1);
    expect([...triedSlow].sort(), 'the slow panes were tried too').toEqual(['%1', '%2']);
  });

  it('one slow pane that is always first does not starve a new error behind it: the new error is recorded in the second pass', async () => {
    const [slow, fresh] = [paneAt(1), paneAt(2)];
    const r = rig([slow, fresh], { panes: { [paneKey(slow)]: waitingEntry(slow, BASE_MS) } });
    r.slow.add(slow.id);

    await r.pass();
    expect(r.state.panes[paneKey(fresh)], 'not reached in the first pass').toBeUndefined();
    expect(r.state.cursor).toBe(paneKey(fresh));

    await r.pass();
    expect(r.state.panes[paneKey(fresh)]?.state).toBe('waiting_quota');
    // The slow pane is the last pane of this pass, and stays behind the others in the next one.
    expect(r.captured).toEqual(['%2', '%1']);
    expect(r.state.cursor).toBe(paneKey(fresh));

    // The reset of the new error comes: it resumes in the next pass, before the slow pane is tried again.
    r.clock.now = BASE_MS + HOUR_MS;
    await r.pass();
    expect(r.captured[0]).toBe('%2');
    expect(r.sent).toEqual(['%2']);
  });

  it('a pass that reached every pane has nothing left to rotate: the cursor is cleared', async () => {
    const [first, second] = [paneAt(1), paneAt(2)];
    const r = rig([first, second], { panes: {}, cursor: paneKey(second) });
    await r.pass();
    expect(r.captured[0], 'the saved cursor decides where the pass starts').toBe('%2');
    expect(r.captured).toEqual(['%2', '%1']);
    expect(r.state.cursor).toBeUndefined();
  });

  it('a pane resumed a moment ago is not captured while the old error text can still be on its screen', async () => {
    const pane = paneAt(1);
    // Settle time is the margin: here a minute.
    const env = { ...ENV, OMC_PANEL_QUOTA_WAIT_MARGIN_S: '60' };
    const resumedAgo = (ms: number): PanelState => ({
      panes: { [paneKey(pane)]: { ...waitingEntry(pane, BASE_MS), state: 'resumed', resumedAt: BASE_MS - ms } },
    });

    const settling = rig([pane], resumedAgo(30_000), env);
    await settling.pass();
    expect(settling.captured, 'inside the settle time').toEqual([]);

    const settled = rig([pane], resumedAgo(90_000), env);
    await settled.pass();
    expect(settled.captured, 'after the settle time the screen is looked at again').toEqual(['%1']);
  });
});
