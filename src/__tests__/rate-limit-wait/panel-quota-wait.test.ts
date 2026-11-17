/**
 * Tests for the opt-in provider quota wait of worker panels (panel-quota-wait.ts).
 * Offline: tmux is an injected fake (screens as data), the clock is set by the test, and the provider
 * reading comes from a loopback HTTP stub. No real tmux, no real key, no live daemon.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runPanelQuotaPass,
  runDaemonPanelQuotaPass,
  detectQuotaError,
  wrapperOwnsPane,
  paneKey,
  planQuotaWait,
  passLimitMs,
  type PanelEnv,
  type PanelQuotaDeps,
  type PanelState,
  type PanelTmux,
  type PanePoint,
  type QuotaReading,
} from '../../features/rate-limit-wait/panel-quota-wait.js';
import { checkPanelQuotaStatus } from '../../features/rate-limit-wait/rate-limit-monitor.js';

const H = 3600_000;
const BASE_MS = Date.parse('2026-11-16T06:00:00Z');
const ERR_1308 = 'API Error: 429 {"error":{"code":1308,"message":"usage limit"}}';
const ERR_1310 = '{"error":{"code":"1310"}}';
// Example preset: Z.ai codes 1308 (5 h window, waits) and 1310 (week or month, never resumed).
const ON: PanelEnv = {
  OMC_PANEL_QUOTA_WAIT: '1',
  OMC_PANEL_QUOTA_WAIT_MARGIN_S: '0',
  OMC_PANEL_QUOTA_WAIT_CODES: '1308',
  OMC_PANEL_QUOTA_END_CODES: '1310',
};
const WRAPPER_LINE = 'external wrapper: quota wait until the reset (attempt 1)';

function screen(text: string, filler = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < filler; i++) lines.push(`line ${i}`);
  lines.push(text);
  return lines.join('\n');
}

// Limits in the shape the provider reading uses: unit 3 = 5 h window, unit 6 = week.
function reading(limits: Array<{ unit: number; percentage: number; nextResetTime: number }>): QuotaReading {
  return { body: { data: { limits } } };
}
const exhausted5h = (resetMs: number): QuotaReading => reading([{ unit: 3, percentage: 100, nextResetTime: resetMs }]);
const exhaustedWeek = (resetMs: number): QuotaReading => reading([{ unit: 6, percentage: 100, nextResetTime: resetMs }]);

interface World {
  clock: { now: number };
  /** null: the pane inventory cannot be read. */
  panes: PanePoint[] | null;
  /** Provider state by pane id; a pane that is not listed runs its provider. */
  running: Record<string, boolean | null>;
  screens: Record<string, string>;
  reading: { value: QuotaReading | null };
  sent: string[];
  log: string[];
  journal: Array<Record<string, unknown>>;
  deps: PanelQuotaDeps;
}

function world(init: { panes: PanePoint[]; screens: Record<string, string>; readingValue: QuotaReading | null }): World {
  const w: World = {
    clock: { now: BASE_MS },
    panes: init.panes,
    running: {},
    screens: init.screens,
    reading: { value: init.readingValue },
    sent: [],
    log: [],
    journal: [],
    deps: undefined as unknown as PanelQuotaDeps,
  };
  w.deps = {
    now: () => w.clock.now,
    listPanes: () => w.panes,
    capture: (pane) => (Object.prototype.hasOwnProperty.call(w.screens, pane.id) ? w.screens[pane.id] : null),
    sendContinue: (pane) => { w.sent.push(pane.id); return true; },
    providerRunning: (pane) => (Object.prototype.hasOwnProperty.call(w.running, pane.id) ? w.running[pane.id] : true),
    readQuota: async () => w.reading.value,
    log: (t) => { w.log.push(t); },
    journal: (row) => { w.journal.push(row); },
  };
  return w;
}

const PANE_A: PanePoint = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 };
const PANE_B: PanePoint = { id: '%8', session: 'omc-team-a', windowIndex: 0, paneIndex: 2 };
const KEY_A = paneKey(PANE_A);

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

  it('a fresh capture that fails at reset time keeps the wait retryable: no keys, still waiting, resumed on the next readable pass', async () => {
    const { w, state } = await waitingAtReset();
    let calls = 0;
    const capture = w.deps.capture;
    // The first capture of the pass reads, the fresh one before the keys fails.
    w.deps.capture = (pane, lines) => (++calls === 2 ? null : capture(pane, lines));
    await runPanelQuotaPass(state, w.deps, ON);
    expect(w.sent).toHaveLength(0);
    expect(state.panes[KEY_A].state).toBe('waiting_quota');

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

  it('a wrapper line that appears between the first capture and the reset-time capture stops the keys', async () => {
    const env = { ...ON, OMC_PANEL_WRAPPER_OWNS_RE: 'external wrapper: quota wait' };
    const { w, state } = await waitingAtReset(env);
    let calls = 0;
    const plain = screen(ERR_1308);
    // The first capture of the pass is plain, the fresh one shows the wrapper's line next to the error.
    w.deps.capture = () => (++calls === 1 ? plain : [ERR_1308, WRAPPER_LINE].join('\n'));
    await runPanelQuotaPass(state, w.deps, env);
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

describe('panel quota wait: daemon entry point and real reading', () => {
  let dir: string;
  let server: Server | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'panel-quota-wait-'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('real reading over loopback: the key is sent as Bearer and never reaches state, journal or log', async () => {
    const SENTINEL = 'SENTINEL-KEY-7f3a91c2';
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, `${SENTINEL}\n`);
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: BASE_MS + H }] } }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const env: PanelEnv = {
      ...ON,
      OMC_PANEL_QUOTA_KEY_FILE: keyFile,
      OMC_PANEL_QUOTA_READ_URL: `http://127.0.0.1:${port}/quota`,
      OMC_PANEL_QUOTA_JOURNAL: join(dir, 'journal.jsonl'),
    };
    const log: string[] = [];
    const sent: string[] = [];
    const tmux: PanelTmux = {
      listPanes: () => [PANE_A],
      capture: () => screen(ERR_1308),
      sendContinue: (pane) => { sent.push(pane.id); return true; },
      providerRunning: () => true,
    };
    const stateDir = join(dir, 'daemon');
    await runDaemonPanelQuotaPass({ stateDir, env, tmux, log: (t) => log.push(t), now: () => BASE_MS });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;

    const stateText = readFileSync(join(stateDir, 'provider-quota-panels.json'), 'utf8');
    const journalText = existsSync(join(dir, 'journal.jsonl')) ? readFileSync(join(dir, 'journal.jsonl'), 'utf8') : '';
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toBe(`Bearer ${SENTINEL}`);
    expect(stateText).toContain('waiting_quota');
    expect(stateText + journalText + log.join('\n')).not.toContain(SENTINEL);
    expect(sent).toHaveLength(0);
  });

  it('switch off: runDaemonPanelQuotaPass writes nothing and returns null', async () => {
    const tmux: PanelTmux = {
      listPanes: () => [PANE_A],
      capture: () => screen(ERR_1308),
      sendContinue: () => true,
      providerRunning: () => true,
    };
    const offDir = join(dir, 'off');
    const out = await runDaemonPanelQuotaPass({ stateDir: offDir, env: {}, tmux, now: () => BASE_MS });
    expect(out).toBeNull();
    expect(existsSync(offDir)).toBe(false);
  });

  it('a missing key file gives no reading: the wait ends with class quota and no keys are sent', async () => {
    const sent: string[] = [];
    const tmux: PanelTmux = {
      listPanes: () => [PANE_A],
      capture: () => screen(ERR_1308),
      sendContinue: (pane) => { sent.push(pane.id); return true; },
      providerRunning: () => true,
    };
    const env: PanelEnv = {
      ...ON,
      OMC_PANEL_QUOTA_KEY_FILE: join(dir, 'no-such-key'),
      OMC_PANEL_QUOTA_READ_URL: 'https://example.invalid/quota',
    };
    const state = await runDaemonPanelQuotaPass({ stateDir: join(dir, 'daemon'), env, tmux, now: () => BASE_MS });
    expect(state?.panes[KEY_A]?.state).toBe('quota-ended');
    expect(sent).toHaveLength(0);
  });
});

describe('panel quota wait: monitor reading is gated by the switch', () => {
  const MONITOR_VARS = ['OMC_PANEL_QUOTA_WAIT', 'OMC_PANEL_QUOTA_KEY_FILE', 'OMC_PANEL_QUOTA_READ_URL'];
  let dir: string;
  let server: Server | null = null;
  let requests = 0;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'panel-quota-switch-'));
    savedEnv = Object.fromEntries(MONITOR_VARS.map((name) => [name, process.env[name]]));
    requests = 0;
    server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { limits: [{ unit: 3, percentage: 100, nextResetTime: BASE_MS + H }] } }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, 'SWITCH-TEST-KEY\n');
    // The URL and the key are set, so a read would really reach the stub: the null below comes from the switch alone.
    process.env.OMC_PANEL_QUOTA_KEY_FILE = keyFile;
    process.env.OMC_PANEL_QUOTA_READ_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/quota`;
  });

  afterEach(async () => {
    for (const name of MONITOR_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('switch off: null without reading, and no request reaches the provider', async () => {
    delete process.env.OMC_PANEL_QUOTA_WAIT;
    expect(await checkPanelQuotaStatus()).toBeNull();
    expect(requests).toBe(0);
  });

  it('switch on: the same setup reads once through the provider endpoint', async () => {
    process.env.OMC_PANEL_QUOTA_WAIT = '1';
    expect(await checkPanelQuotaStatus()).not.toBeNull();
    expect(requests).toBe(1);
  });
});
