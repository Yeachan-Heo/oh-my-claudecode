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
  panes: PanePoint[];
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
    readQuota: async () => w.reading.value,
    log: (t) => { w.log.push(t); },
    journal: (row) => { w.journal.push(row); },
  };
  return w;
}

const PANE_A: PanePoint = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 };
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

  it('week reset: no resume, task ends with class quota and the reset date', async () => {
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
    };
    const offDir = join(dir, 'off');
    const out = await runDaemonPanelQuotaPass({ stateDir: offDir, env: {}, tmux, now: () => BASE_MS });
    expect(out).toBeNull();
    expect(existsSync(offDir)).toBe(false);
  });

  it('a missing key file gives no reading: the task ends with class quota and no keys are sent', async () => {
    const sent: string[] = [];
    const tmux: PanelTmux = {
      listPanes: () => [PANE_A],
      capture: () => screen(ERR_1308),
      sendContinue: (pane) => { sent.push(pane.id); return true; },
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
