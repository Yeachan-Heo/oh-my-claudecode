/**
 * Tests for the opt-in provider quota wait of worker panels (panel-quota-wait.ts): the decision logic.
 * Offline: tmux is an injected fake (screens as data), the clock is set by the test, and the provider reading comes
 * from a loopback HTTP stub. The helpers are in panel-quota-wait-fixtures.ts.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { runPanelQuotaPass, detectQuotaError, wrapperOwnsPane, paneKey, planQuotaWait, passLimitMs, type PanelEnv, type PanelQuotaDeps, type PanelState, type PanePoint, type QuotaReading } from '../../features/rate-limit-wait/panel-quota-wait.js';
import { BASE_MS, ERR_1308, ERR_1310, H, KEY_A, ON, PANE_A, PANE_B, WRAPPER_LINE, World, exhausted5h, exhaustedWeek, reading, screen, world } from './panel-quota-wait-fixtures.js';

describe('panel quota wait: decision logic', () => {
  it('waits until the 5 h reset, then resumes exactly once', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    const e = state.panes[KEY_A];
    expect(e && e.state === 'waiting_quota' && e.untilMs === BASE_MS + 2 * H && e.waits === 1).toBe(true);

    w.clock.now = BASE_MS + 2 * H - 1000;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toHaveLength(0);

    w.clock.now = BASE_MS + 2 * H;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toEqual(['%7']);
    expect(state.panes[KEY_A].state).toBe('resumed');
    expect(w.journal.some((r) => r.result === 'quota-wait' && r.state === 'waiting_quota')).toBe(true);
    expect(w.journal.some((r) => r.result === 'resume')).toBe(true);

    w.clock.now += 30 * 60_000;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toHaveLength(1);
  });

  it('the same pane id on the default server and on a private endpoint is two panes: each waits and resumes once', async () => {
    const privatePane = { ...PANE_A, socket: '/tmp/o-1k-lz9x2b-1a2b3c4d.sock' };
    const w = world({ panes: [PANE_A, privatePane], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(Object.keys(state.panes).sort()).toEqual([paneKey(privatePane), paneKey(PANE_A)].sort());
    expect(Object.values(state.panes).map((entry) => entry.state)).toEqual(['waiting_quota', 'waiting_quota']);

    w.clock.now = BASE_MS + 2 * H;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent, 'one key for each of the two panes').toEqual(['%7', '%7']);
  });

  it('a pane that leaves the session prefix keeps its delivery guard: back in the prefix, the unchanged error gets no second key', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const sig = createHash('sha256').update(screen(ERR_1308)).digest('hex').slice(0, 16);
    const state: PanelState = {
      panes: { [KEY_A]: { key: KEY_A, pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, waits: 1, state: 'resumed', unconfirmed: true, sig, resumedAt: BASE_MS - 2 * H } },
    };
    // The same pane, moved to a session outside the prefix: still listed, never inspected or sent to.
    w.panes = [{ ...PANE_A, session: 'elsewhere' }];
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A]?.unconfirmed, 'the delivery guard of a live pane was dropped').toBe(true);
    expect(w.sent).toEqual([]);

    // A pane that is gone loses its entry.
    w.panes = [];
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A]).toBeUndefined();
  });

  it('a pane that moved back into the prefix with the same unconfirmed error is not sent a second key', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const sig = createHash('sha256').update(screen(ERR_1308)).digest('hex').slice(0, 16);
    const state: PanelState = {
      panes: { [KEY_A]: { key: KEY_A, pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, waits: 1, state: 'resumed', unconfirmed: true, sig, resumedAt: BASE_MS - 2 * H } },
    };
    w.panes = [{ ...PANE_A, session: 'elsewhere' }];
    await runPanelQuotaPass(state, w.deps, ON);
    w.panes = [PANE_A];
    await runPanelQuotaPass(state, w.deps, ON);
    w.clock.now = BASE_MS + 3 * H;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent, 'a second key went to a pane with a partly delivered first one').toEqual([]);
  });

  describe('the key goes only to the program that was running when the wait began', () => {
    async function waitingWorld(identity: { value: string | null }): Promise<{ w: World; state: PanelState }> {
      const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
      w.deps.providerIdentity = () => identity.value;
      const state: PanelState = { panes: {} };
      await runPanelQuotaPass(state, w.deps, ON);
      expect(state.panes[KEY_A].state).toBe('waiting_quota');
      return { w, state };
    }

    it('the same program at the reset: the key is sent', async () => {
      const identity = { value: '5151:started-at-ten' };
      const { w, state } = await waitingWorld(identity);
      expect(state.panes[KEY_A].providerIdentity).toBe('5151:started-at-ten');
      w.clock.now = BASE_MS + 2 * H;
      await runPanelQuotaPass(state, w.deps, ON);
      expect(w.sent).toEqual(['%7']);
    });

    it('another program in the foreground that is not a shell: no key, and the wait is closed', async () => {
      const identity = { value: '5151:started-at-ten' };
      const { w, state } = await waitingWorld(identity);
      identity.value = '6262:started-at-eleven';
      w.clock.now = BASE_MS + 2 * H;
      await runPanelQuotaPass(state, w.deps, ON);
      expect(w.sent, 'the key went to an unrelated program').toEqual([]);
      expect(state.panes[KEY_A].state).toBe('resumed');
      expect(w.log.some((text) => /no longer runs there; no keys sent/.test(text))).toBe(true);
    });

    it('an identity that cannot be read when the wait would begin: no wait is started, so no key can follow, and the wait begins once it can be read', async () => {
      const identity: { value: string | null } = { value: null };
      const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
      w.deps.providerIdentity = () => identity.value;
      const state: PanelState = { panes: {} };
      await runPanelQuotaPass(state, w.deps, ON);
      expect(state.panes[KEY_A]?.state, 'a wait was started without the program it is bound to').toBeUndefined();
      expect(state.panes[KEY_A]?.providerIdentity).toBeUndefined();

      // The provider exits and an unrelated program takes the pane while the identity still cannot be read.
      w.clock.now = BASE_MS + 2 * H;
      await runPanelQuotaPass(state, w.deps, ON);
      expect(w.sent, 'the key went to a program that was never identified').toEqual([]);

      identity.value = '5151:started-at-ten';
      await runPanelQuotaPass(state, w.deps, ON);
      expect(state.panes[KEY_A].providerIdentity).toBe('5151:started-at-ten');
    });

    it('a saved wait that has no recorded program gets no key: it is dropped and detected again with the program recorded', async () => {
      const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 4 * H) });
      w.deps.providerIdentity = () => '5151:started-at-ten';
      const state: PanelState = {
        panes: { [KEY_A]: { key: KEY_A, pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, waits: 1, state: 'waiting_quota', untilMs: BASE_MS, resetMs: BASE_MS, sig: null } },
      };
      await runPanelQuotaPass(state, w.deps, ON);
      expect(w.sent, 'a wait with no recorded program authorized a key').toEqual([]);
      expect(w.log.some((text) => /no recorded program/.test(text))).toBe(true);
      await runPanelQuotaPass(state, w.deps, ON);
      expect(state.panes[KEY_A].state).toBe('waiting_quota');
      expect(state.panes[KEY_A].providerIdentity).toBe('5151:started-at-ten');
      expect(w.sent).toEqual([]);
    });

    it('an identity that cannot be read at the reset: no key, and the wait is tried again on the next pass', async () => {
      const identity: { value: string | null } = { value: '5151:started-at-ten' };
      const { w, state } = await waitingWorld(identity);
      identity.value = null;
      w.clock.now = BASE_MS + 2 * H;
      await runPanelQuotaPass(state, w.deps, ON);
      expect(w.sent).toEqual([]);
      expect(state.panes[KEY_A].state).toBe('waiting_quota');
      identity.value = '5151:started-at-ten';
      await runPanelQuotaPass(state, w.deps, ON);
      expect(w.sent).toEqual(['%7']);
    });
  });

  it('week reset: no resume, the wait ends with class quota and the reset date', async () => {
    const reset = BASE_MS + 3 * 24 * H;
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhaustedWeek(reset) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    const end = w.journal.find((r) => r.result === 'end');
    expect(w.sent).toHaveLength(0);
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(end && end.class === 'quota' && end.reset_ms === reset).toBe(true);
    expect(w.log.some((t) => t.includes(new Date(reset).toISOString()))).toBe(true);
  });

  it('fourth detection is refused after three waits', async () => {
    const w = world({ panes: [PANE_A], screens: {}, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    for (let i = 1; i <= 4; i++) {
      w.screens['%7'] = screen(ERR_1308, i);
      w.reading.value = exhausted5h(w.clock.now + H);
      await runPanelQuotaPass(state, w.deps, ON);
      if (i <= 3) {
        w.clock.now = state.panes[KEY_A].untilMs as number;
        await runPanelQuotaPass(state, w.deps, ON);
        w.clock.now += 10 * 60_000;
      }
    }
    expect(w.sent).toHaveLength(3);
    const last = w.journal.at(-1) as Record<string, unknown>;
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(last.result).toBe('end');
    expect(String(last.reason)).toContain('limit');
  });

  it('switch off: state untouched, nothing read or sent', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    let reads = 0;
    w.deps.readQuota = async () => { reads++; return w.reading.value; };
    const out = await runPanelQuotaPass(state, w.deps, { OMC_PANEL_QUOTA_WAIT: '0', OMC_PANEL_QUOTA_WAIT_CODES: '1308' });
    expect(out).toBe(state);
    expect(Object.keys(state.panes)).toHaveLength(0);
    expect(reads).toBe(0);
    expect(w.sent).toHaveLength(0);
    expect(w.journal).toHaveLength(0);
  });

  it('only sessions with the prefix are inspected; a plain shell pane is never captured', async () => {
    const plain: PanePoint = { id: '%9', session: 'work', windowIndex: 0, paneIndex: 0 };
    const w = world({ panes: [plain], screens: { '%9': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + H) });
    let captures = 0;
    const capture = w.deps.capture;
    w.deps.capture = (p, lines) => { captures++; return capture(p, lines); };
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(captures).toBe(0);
    expect(Object.keys(state.panes)).toHaveLength(0);
  });

  it('an old error above the last 15 lines is not a live error', async () => {
    const buried = [ERR_1308, ...Array.from({ length: 20 }, (_, i) => `output ${i}`)].join('\n');
    const w = world({ panes: [PANE_A], screens: { '%7': buried }, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(Object.keys(state.panes)).toHaveLength(0);
  });

  it('detection joins a line wrapped at the pane width and matches only API error lines', () => {
    const codes = { wait: [1308], end: [1310] };
    expect(detectQuotaError('API Error: 429 {"error":{"co\nde":1308,"message":"usage limit"}}', codes)?.code).toBe(1308);
    expect(detectQuotaError(ERR_1310, codes)?.code).toBe(1310);
    expect(detectQuotaError('API Error: 429 rate limit exceeded', codes)).toBeNull();
    expect(detectQuotaError('the snippet says code: 1308 here', codes)).toBeNull();
  });

  it('when both 1308 and 1310 are in the tail, detects the latest (1310), not the first (1308)', () => {
    const codes = { wait: [1308], end: [1310] };
    // Multiple errors with 1310 appearing after 1308: should detect 1310 (latest)
    const contentWithBothErrors = [
      'line 1',
      'line 2',
      'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}',
      'retry in 5h',
      'API Error: 429 {"error":{"code":1310,"message":"quota exceeded"}}',
    ].join('\n');
    const result = detectQuotaError(contentWithBothErrors, codes);
    expect(result?.code).toBe(1310);
    // Also test when 1310 is first and 1308 appears later
    const contentReversed = [
      'API Error: 429 {"error":{"code":1310,"message":"quota exceeded"}}',
      'retry',
      'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}',
    ].join('\n');
    const resultReversed = detectQuotaError(contentReversed, codes);
    expect(resultReversed?.code).toBe(1308);
  });

  it('with no codes configured nothing is detected', async () => {
    expect(detectQuotaError(ERR_1308, { wait: [], end: [] })).toBeNull();
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, { OMC_PANEL_QUOTA_WAIT: '1' });
    expect(Object.keys(state.panes)).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it('a non-resumable code (1310) never waits, whatever the reading says', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1310) }, readingValue: exhaustedWeek(BASE_MS + 2 * H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(w.sent).toHaveLength(0);
    expect(w.journal.some((r) => r.result === 'end' && r.class === 'quota')).toBe(true);
  });

  it('non-resumable code with only the 5 h window exhausted: no wait, class quota, reason names the code', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1310) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(w.sent).toHaveLength(0);
    expect(w.journal.some((r) => r.result === 'end' && r.class === 'quota' && r.reason === 'quota error 1310 is non-resumable: no resume')).toBe(true);
  });

  it('1308 with the week exhausted and its reset inside the window: no wait, weekly reason', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhaustedWeek(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    const end = w.journal.find((r) => r.result === 'end');
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(w.sent).toHaveLength(0);
    expect(end && end.class === 'quota' && /weekly or monthly limit exhausted/.test(String(end.reason))).toBe(true);
  });

  it('both windows exhausted, both resets inside 5 h: the week decides, no wait', async () => {
    const weekReset = BASE_MS + H;
    const w = world({
      panes: [PANE_A],
      screens: { '%7': screen(ERR_1308) },
      readingValue: reading([
        { unit: 3, percentage: 100, nextResetTime: BASE_MS + 2 * H },
        { unit: 6, percentage: 100, nextResetTime: weekReset },
      ]),
    });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(w.sent).toHaveLength(0);
    expect(w.journal.some((r) => r.result === 'quota-wait')).toBe(false);
  });

  it('a pane that disappears loses its entry', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    w.panes = [];
    await runPanelQuotaPass(state, w.deps, ON);
    expect(Object.keys(state.panes)).toHaveLength(0);
  });

  // A pane in the waiting state whose reset has come (margin 0), ready for the pass that decides about the keys.
  async function waitingAtReset(env: PanelEnv = ON): Promise<{ w: World; state: PanelState }> {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, env);
    expect(state.panes[KEY_A].state).toBe('waiting_quota');
    w.clock.now = BASE_MS + 2 * H;
    return { w, state };
  }

  it('an unreadable pane inventory keeps the saved waits: nothing is deleted, scanned or sent, and the wait resumes when the inventory is back', async () => {
    const { w, state } = await waitingAtReset();
    w.panes = null;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A]?.state, 'the wait was dropped with the inventory').toBe('waiting_quota');
    expect(w.sent).toHaveLength(0);
    expect(w.log.some((t) => /inventory unavailable/.test(t))).toBe(true);

    w.panes = [PANE_A];
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toEqual(['%7']);
    expect(state.panes[KEY_A].state).toBe('resumed');
  });

  it('a pane that changes its window or pane index keeps its wait: the key is the pane id and the position is refreshed', async () => {
    const { w, state } = await waitingAtReset();
    const moved: PanePoint = { id: '%7', session: 'omc-team-a', windowIndex: 3, paneIndex: 0 };
    w.panes = [moved];
    await runPanelQuotaPass(state, w.deps, ON);
    expect(Object.keys(state.panes)).toEqual([KEY_A]);
    expect(w.sent, 'the moved pane was not resumed').toEqual(['%7']);
    const entry = state.panes[KEY_A];
    expect(entry.state).toBe('resumed');
    expect(entry.windowIndex).toBe(3);
    expect(entry.paneIndex).toBe(0);
    expect(w.log.some((t) => /no quota error on screen/.test(t))).toBe(false);
  });

  it('a capture that fails at reset time keeps the wait retryable: no keys, still waiting, resumed on the next readable pass', async () => {
    const { w, state } = await waitingAtReset();
    const capture = w.deps.capture;
    // A due wait is captured once, right before the key: that capture fails.
    w.deps.capture = () => null;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toHaveLength(0);
    expect(state.panes[KEY_A].state).toBe('waiting_quota');
    expect(w.log.some((t) => /capture failed at reset time/.test(t))).toBe(true);

    w.deps.capture = capture;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toEqual(['%7']);
    expect(state.panes[KEY_A].state).toBe('resumed');
  });

  it('a code that turned non-resumable before the reset ends the wait and sends no key', async () => {
    const { w, state } = await waitingAtReset();
    w.screens['%7'] = screen(ERR_1310);
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toHaveLength(0);
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(w.journal.some((r) => r.result === 'end' && r.class === 'quota')).toBe(true);
  });

  it('an older resumable error and a newer non-resumable one in the same tail: the newer decides, no wait and no key', async () => {
    const both = [ERR_1308, 'retrying...', 'API Error: 429 {"error":{"code":1310,"message":"quota exceeded"}}'].join('\n');
    const w = world({ panes: [PANE_A], screens: { '%7': both }, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    w.clock.now = BASE_MS + 2 * H;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A].state).toBe('quota-ended');
    expect(state.panes[KEY_A].waits).toBe(0);
    expect(w.sent).toHaveLength(0);
  });

  it('a wrapper line on the screen at reset time stops the keys, and a due wait is captured exactly once', async () => {
    const env = { ...ON, OMC_PANEL_WRAPPER_OWNS_RE: 'external wrapper: quota wait' };
    const { w, state } = await waitingAtReset(env);
    let captures = 0;
    // The wrapper's line appears next to the error after the wait began.
    w.deps.capture = () => { captures++; return [ERR_1308, WRAPPER_LINE].join('\n'); };
    await runPanelQuotaPass(state, w.deps, env);
    expect(captures, 'one capture, right before the key').toBe(1);
    expect(w.sent).toHaveLength(0);
    expect(state.panes[KEY_A].state).toBe('waiting_quota');
    expect(w.log.some((t) => /wrapper owns this error at reset time/.test(t))).toBe(true);
  });

  it('a pane whose provider exited during the wait gets no key; an unknown provider state is retried on the next pass', async () => {
    const { w, state } = await waitingAtReset();
    w.running['%7'] = null;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toHaveLength(0);
    expect(state.panes[KEY_A].state, 'an unknown state must keep the wait').toBe('waiting_quota');

    w.running['%7'] = false;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent, 'the key would be typed into the shell').toHaveLength(0);
    expect(state.panes[KEY_A].state).toBe('resumed');
    expect(w.log.some((t) => /provider no longer runs in the pane/.test(t))).toBe(true);
    expect(w.journal.some((r) => r.result === 'resume')).toBe(false);
  });

  it('due resumes run before new detections: a pane whose reading never answers does not hold back a pane that is due', async () => {
    const { w, state } = await waitingAtReset();
    // Listed first: a second pane with a new error whose provider reading never comes back.
    w.panes = [PANE_B, PANE_A];
    w.screens['%8'] = screen(ERR_1308);
    w.deps.readQuota = () => new Promise<QuotaReading | null>(() => {});
    await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.2' });
    expect(w.sent, 'the due pane was not resumed').toEqual(['%7']);
    expect(state.panes[KEY_A].state).toBe('resumed');
    expect(w.log.filter((t) => /time limit/.test(t))).toHaveLength(1);
  });

  it('a pass that ran out of time on one new pane starts the next pass at the pane after it', async () => {
    const w = world({ panes: [PANE_A, PANE_B], screens: { '%7': screen(ERR_1308), '%8': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const captured: string[] = [];
    const capture = w.deps.capture;
    w.deps.capture = (pane, lines) => { captured.push(pane.id); return capture(pane, lines); };
    const state: PanelState = { panes: {} };
    // Pass 1: the reading for the first pane never comes back.
    w.deps.readQuota = () => new Promise<QuotaReading | null>(() => {});
    await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.1' });
    expect(captured).toEqual(['%7']);
    expect(state.cursor).toBe(paneKey(PANE_B));

    // Pass 2 reads fast and begins with the pane that the last pass did not reach.
    captured.length = 0;
    w.deps.readQuota = async () => w.reading.value;
    await runPanelQuotaPass(state, w.deps, ON);
    expect(captured[0]).toBe('%8');
    expect(state.panes[paneKey(PANE_B)].state).toBe('waiting_quota');
    expect(state.panes[KEY_A].state).toBe('waiting_quota');
    expect(state.cursor).toBeUndefined();
  });

  it('an external wrapper that owns the wait: no entry, no keys, the pane is left alone', async () => {
    const owned = [ERR_1308, WRAPPER_LINE].join('\n');
    const w = world({ panes: [PANE_A], screens: { '%7': owned }, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    const env = { ...ON, OMC_PANEL_WRAPPER_OWNS_RE: 'external wrapper: quota wait' };
    await runPanelQuotaPass(state, w.deps, env);
    expect(Object.keys(state.panes)).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
    expect(w.journal).toHaveLength(0);
    expect(wrapperOwnsPane(owned, /external wrapper: quota wait/)).toBe(true);
    expect(wrapperOwnsPane(ERR_1308, /external wrapper: quota wait/)).toBe(false);
  });

  it('with no wrapper pattern configured, a wrapper-like line does not stop the wait', async () => {
    const owned = [ERR_1308, WRAPPER_LINE].join('\n');
    const w = world({ panes: [PANE_A], screens: { '%7': owned }, readingValue: exhausted5h(BASE_MS + H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A].state).toBe('waiting_quota');
  });

  it('a reading slower than the pass limit ends the pass at once: no keys, no wait counted, one log row', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    w.deps.readQuota = async () => { await new Promise((r) => setTimeout(r, 500)); return w.reading.value; };
    const state: PanelState = { panes: {} };
    const started = Date.now();
    await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.05' });
    const took = Date.now() - started;
    const e = state.panes[KEY_A];
    expect(took).toBeLessThan(400);
    expect(w.sent).toHaveLength(0);
    expect(!e || (e.waits === 0 && e.state === undefined)).toBe(true);
    expect(w.log.filter((t) => /time limit/.test(t))).toHaveLength(1);
    expect(w.log.some((t) => /pass failed/.test(t))).toBe(false);
  });

  it('the limit is checked before the keys: the reset has come but the pass clock ran out, nothing is sent', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    const before = { ...state.panes[KEY_A] };
    w.clock.now = (before.untilMs as number) + 1;
    let ticks = 0;
    const deps: PanelQuotaDeps = { ...w.deps, monotonic: () => { ticks += 10; return ticks; } };
    await runPanelQuotaPass(state, deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.015' });
    const after = state.panes[KEY_A];
    expect(w.sent).toHaveLength(0);
    expect(after.state).toBe('waiting_quota');
    expect(after.waits).toBe(before.waits);
    expect(w.log.filter((t) => /time limit/.test(t))).toHaveLength(1);
    expect(w.journal.some((r) => r.result === 'resume')).toBe(false);
  });

  it('pass limit: default 30 s; zero, negative and non-numeric values fall back to it; numbers are seconds', () => {
    const lim = (v: string) => passLimitMs({ OMC_PANEL_QUOTA_PASS_LIMIT_S: v });
    expect(passLimitMs({})).toBe(30000);
    expect(lim('')).toBe(30000);
    expect(lim('abc')).toBe(30000);
    expect(lim('0')).toBe(30000);
    expect(lim('-5')).toBe(30000);
    expect(lim('5')).toBe(5000);
    expect(lim('0.5')).toBe(500);
  });

  it('default limit: a 50 ms reading does not end the pass; the wait starts', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    w.deps.readQuota = async () => { await new Promise((r) => setTimeout(r, 50)); return w.reading.value; };
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A]?.state).toBe('waiting_quota');
    expect(w.log.some((t) => /time limit/.test(t))).toBe(false);
  });

  it('planQuotaWait: a reset exactly at the window edge waits; a missing reset time does not', () => {
    const edge = planQuotaWait({ data: { limits: [{ unit: 3, percentage: 100, nextResetTime: BASE_MS + 5 * H }] } }, BASE_MS, 5 * H, 0);
    expect(edge).toEqual({ wait: true, reset: BASE_MS + 5 * H, untilMs: BASE_MS + 5 * H });
    const missing = planQuotaWait({ data: { limits: [{ unit: 3, percentage: 100 }] } }, BASE_MS);
    expect(missing.wait).toBe(false);
  });

  it('week unit: by default unit 6 is the weekly code, so unit 7 waits; OMC_PANEL_QUOTA_WEEK_UNIT=7 makes unit 7 the weekly code; invalid values fall back to 6', async () => {
    const unit7 = reading([{ unit: 7, percentage: 100, nextResetTime: BASE_MS + 2 * H }]);
    const stateAfterPass = async (extra: PanelEnv): Promise<string | undefined> => {
      const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: unit7 });
      const state: PanelState = { panes: {} };
      await runPanelQuotaPass(state, w.deps, { ...ON, ...extra });
      return state.panes[KEY_A]?.state;
    };
    expect(await stateAfterPass({})).toBe('waiting_quota');
    expect(await stateAfterPass({ OMC_PANEL_QUOTA_WEEK_UNIT: '7' })).toBe('quota-ended');
    expect(await stateAfterPass({ OMC_PANEL_QUOTA_WEEK_UNIT: 'abc' })).toBe('waiting_quota');
    expect(await stateAfterPass({ OMC_PANEL_QUOTA_WEEK_UNIT: '-1' })).toBe('waiting_quota');
  });
});
