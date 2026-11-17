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
    sendContinue: (pane) => { w.sent.push(pane.id); return 'delivered'; },
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

// Every effect of the pass, in the order a state of a pane changes: the state a restart finds on disk is the last one
// that was saved (`persisted`), which the tests keep as JSON, as the daemon's state file would hold it.
describe('panel quota wait: state transitions and their effects', () => {
  interface Disk { events: string[]; saved: string | null; persistFails: boolean }

  function withDisk(w: World): Disk {
    const disk: Disk = { events: [], saved: null, persistFails: false };
    w.deps.persist = (state) => {
      if (disk.persistFails) throw new Error('disk full');
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

  async function waitingAtResetWithDisk(): Promise<{ w: World; state: PanelState; disk: Disk }> {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const disk = withDisk(w);
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    expect(state.panes[KEY_A].state).toBe('waiting_quota');
    w.clock.now = BASE_MS + 2 * H;
    disk.events.length = 0;
    return { w, state, disk };
  }

  // Row: waiting x all guards pass -> the intent is on disk before the key
  it('the resume intent is saved before the key is sent, and the resumed state after it', async () => {
    const { w, state, disk } = await waitingAtResetWithDisk();
    const sendSeesIntent: string[] = [];
    const send = w.deps.sendContinue;
    w.deps.sendContinue = (pane) => {
      sendSeesIntent.push(String((JSON.parse(disk.saved as string) as PanelState).panes[KEY_A].state));
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
    expect((JSON.parse(disk.saved as string) as PanelState).panes[KEY_A].state, 'a restart would not retry the resume').toBe('waiting_quota');
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
    const onDisk = JSON.parse(disk.saved as string) as PanelState;
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
    const onDisk: PanelState = { panes: { [KEY_A]: { key: KEY_A, pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, waits: 1, state: 'resuming', sig: 'abc', resumedAt: BASE_MS } } };
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
    const onDisk: PanelState = { panes: { [KEY_A]: { key: KEY_A, pane: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, waits: 1, state: 'resuming', sig: 'abc', resumedAt: BASE_MS } } };
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
    const state: PanelState = { panes: {} };
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
    w.deps.readQuota = () => new Promise<QuotaReading | null>(() => {});
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
    w.deps.readQuota = () => { reads++; return new Promise<QuotaReading | null>(() => {}); };
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '0.1' });
    expect(state.panes[KEY_A].state, 'the end code waited for the reading and was not decided').toBe('quota-ended');
    const end = w.journal.find((r) => r.result === 'end') as Record<string, unknown>;
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
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, ON);
    const end = w.journal.find((r) => r.result === 'end') as Record<string, unknown>;
    expect(end.reset_ms).toBe(reset);
    expect(w.log.some((t) => t.includes(new Date(reset).toISOString()))).toBe(true);
  });

  it('an end code on a pane with no time left in the pass is still decided, and the pass stops', async () => {
    const w = world({ panes: [PANE_A, PANE_B], screens: { '%7': screen(ERR_1310), '%8': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    let ticks = 0;
    // The start of the pass and the check at the top of the loop see time left; every later look is past the limit.
    w.deps.monotonic = () => (ticks++ < 2 ? 0 : 10_000);
    const state: PanelState = { panes: {} };
    await runPanelQuotaPass(state, w.deps, { ...ON, OMC_PANEL_QUOTA_PASS_LIMIT_S: '1' });
    expect(state.panes[KEY_A]?.state, 'the pane with the end code was left undecided').toBe('quota-ended');
    expect(state.panes[paneKey(PANE_B)], 'the pass went on after its time ran out').toBeUndefined();
  });

  // Rows without an effect outside the state: a retry changes nothing that a restart could repeat.
  it('a restart after a pass that saved nothing repeats only what has no irreversible effect: the same wait is detected again', async () => {
    const w = world({ panes: [PANE_A], screens: { '%7': screen(ERR_1308) }, readingValue: exhausted5h(BASE_MS + 2 * H) });
    const lost: PanelState = { panes: {} };
    await runPanelQuotaPass(lost, w.deps, ON);
    const restarted: PanelState = { panes: {} };
    await runPanelQuotaPass(restarted, w.deps, ON);
    expect(restarted.panes[KEY_A].state).toBe('waiting_quota');
    expect(w.sent).toHaveLength(0);
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
      sendContinue: (pane) => { sent.push(pane.id); return 'delivered'; },
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
      sendContinue: () => 'delivered',
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
      sendContinue: (pane) => { sent.push(pane.id); return 'delivered'; },
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
