/**
 * Opt-in quota wait for the worker panels of `omc team`.
 *
 * Switch: OMC_PANEL_QUOTA_WAIT=1 (off by default; with the switch off nothing is read, nothing is
 * sent and no state is written).
 *
 * The rate-limit-wait daemon calls runDaemonPanelQuotaPass once per poll. A team pane whose last lines
 * show a provider quota error waits until the reset of the 5 h window plus a margin, then receives one
 * continue key. A non-resumable code, a reset beyond the window, an exhausted weekly limit, or the wait
 * limit ends the task with class "quota"; the reset date goes to the log and to the optional journal.
 *
 * Tmux, the clock and the provider reading are injected, so the decision logic runs in tests without
 * tmux or a live account. The API key is read from the file named by OMC_PANEL_QUOTA_KEY_FILE and is never
 * written to the state file, the journal or the log.
 *
 * Configuration (default in brackets):
 *   OMC_PANEL_QUOTA_WAIT_CODES   codes that wait for the reset ([none: nothing is detected])
 *   OMC_PANEL_QUOTA_END_CODES    codes that never resume ([none])
 *   OMC_PANEL_QUOTA_READ_URL     reading endpoint, https or loopback http ([none: no reading, no wait])
 *   OMC_PANEL_QUOTA_KEY_FILE    file holding the API key ([none: no reading])
 *   OMC_PANEL_QUOTA_WAIT_MAX     waits per pane before the task ends ([3])
 *   OMC_PANEL_QUOTA_WAIT_MARGIN_S margin after the reset, seconds ([120])
 *   OMC_PANEL_QUOTA_PASS_LIMIT_S time limit of one pass, seconds ([30])
 *   OMC_PANEL_QUOTA_WEEK_UNIT    unit code of the weekly limit in the reading ([6]; a weekly limit never waits)
 *   OMC_PANEL_SESSION_PREFIX only sessions with this prefix are inspected ([omc-])
 *   OMC_PANEL_WRAPPER_OWNS_RE    panes whose tail matches this pattern are left alone ([none])
 *   OMC_PANEL_QUOTA_STATE        state file ([provider-quota-panels.json next to the daemon state])
 *   OMC_PANEL_QUOTA_JOURNAL      optional JSON Lines journal ([none])
 *
 * Example preset for Z.ai: OMC_PANEL_QUOTA_WAIT_CODES=1308, OMC_PANEL_QUOTA_END_CODES=1310,
 * OMC_PANEL_QUOTA_READ_URL=https://api.z.ai/api/monitor/usage/quota/limit.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type PanelEnv = Readonly<Record<string, string | undefined>>;

export interface PanePoint {
  id: string;
  session: string;
  windowIndex: number;
  paneIndex: number;
}

/** Provider reading: the raw JSON body with `data.limits` (or a bare array of limits). */
export interface QuotaReading {
  body: unknown;
}

export interface PanelTmux {
  listPanes(): PanePoint[];
  capture(pane: PanePoint, lines: number): string | null;
  sendContinue(pane: PanePoint): boolean;
}

export interface PanelEntry {
  key: string;
  pane: string;
  session: string;
  windowIndex: number;
  paneIndex: number;
  waits: number;
  state?: 'waiting_quota' | 'resumed' | 'quota-ended';
  sig?: string | null;
  updatedAt?: number;
  resumedAt?: number;
  untilMs?: number;
  resetMs?: number | null;
}

export interface PanelState {
  panes: Record<string, PanelEntry>;
}

export interface QuotaCodes {
  wait: number[];
  end: number[];
}

export type WaitPlan =
  | { wait: true; reset: number; untilMs: number }
  | { wait: false; reason: string; reset?: number };

type Journal = Record<string, unknown>;

export interface PanelQuotaDeps {
  now(): number;
  monotonic?(): number;
  listPanes(): PanePoint[];
  capture(pane: PanePoint, lines: number): string | null | undefined;
  sendContinue(pane: PanePoint): boolean;
  readQuota(): Promise<QuotaReading | null>;
  log(text: string): void;
  journal(row: Journal): void;
}

interface QuotaLimit {
  unit?: number;
  percentage?: number;
  nextResetTime?: number;
}

const TAIL_LINES = 15;
const DEFAULT_MAX_WAITS = 3;
const DEFAULT_SESSION_PREFIX = 'omc-';
const DEFAULT_PASS_LIMIT_S = 30;
const DEFAULT_MARGIN_MS = 120_000; // the provider applies the reset before the retry
const QUOTA_WINDOW_MS = 5 * 3600_000;
const EXHAUSTED_PERCENT = 100;
const DEFAULT_WEEK_LIMIT_UNIT = 6; // unit code of the weekly limit in the Z.ai reading (the 5 h window is unit 3); a weekly limit never waits
const READ_TIMEOUT_MS = 10_000;
const STATE_FILE_NAME = 'provider-quota-panels.json';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const TIME_LIMIT = Symbol('pass time limit');

function enabled(env: PanelEnv): boolean {
  return env.OMC_PANEL_QUOTA_WAIT === '1';
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const text = String(value ?? '').trim();
  const number = Number(text);
  return text !== '' && Number.isInteger(number) && number >= 0 ? number : fallback;
}

function waitsLimit(env: PanelEnv): number {
  return nonNegativeInteger(env.OMC_PANEL_QUOTA_WAIT_MAX, DEFAULT_MAX_WAITS);
}

// Margin after the reset, in ms.
function marginMs(env: PanelEnv): number {
  const text = String(env.OMC_PANEL_QUOTA_WAIT_MARGIN_S ?? '').trim();
  const seconds = Number(text);
  return text !== '' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_MARGIN_MS;
}

function sessionPrefix(env: PanelEnv): string {
  return env.OMC_PANEL_SESSION_PREFIX || DEFAULT_SESSION_PREFIX;
}

// Codes come from a comma-separated list; only plain digit strings are kept, so they are safe to put into a pattern.
function parseCodes(text: string | undefined): number[] {
  return String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d{1,9}$/.test(part))
    .map(Number);
}

function quotaCodes(env: PanelEnv): QuotaCodes {
  return { wait: parseCodes(env.OMC_PANEL_QUOTA_WAIT_CODES), end: parseCodes(env.OMC_PANEL_QUOTA_END_CODES) };
}

// Pattern of an error line: the API error line (or the JSON "error" object) carries one of the configured codes.
// Lines are joined before matching, because capture-pane without -J splits long lines at the pane width.
function quotaErrorPattern(codes: QuotaCodes): RegExp | null {
  const all = [...codes.wait, ...codes.end];
  if (all.length === 0) return null;
  return new RegExp(`(?:API Error|"error")[^\\n]{0,300}?"?code"?\\s*[:=]\\s*"?(${all.join('|')})\\b`);
}

// Optional pattern for lines an external wrapper prints while it owns the wait; empty or invalid: no wrapper check.
function wrapperPattern(env: PanelEnv): RegExp | null {
  const text = env.OMC_PANEL_WRAPPER_OWNS_RE;
  if (!text) return null;
  try {
    return new RegExp(text);
  } catch {
    return null;
  }
}

// The last TAIL_LINES non-empty lines of a captured pane, with trailing spaces removed.
function tailLines(content: string): string[] {
  return String(content ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .slice(-TAIL_LINES);
}

// Returns { code } when a configured quota error is in the tail of the pane, otherwise null.
export function detectQuotaError(content: string, codes: QuotaCodes): { code: number } | null {
  const pattern = quotaErrorPattern(codes);
  if (!pattern) return null;
  const match = pattern.exec(tailLines(content).join(''));
  return match ? { code: Number(match[1]) } : null;
}

// True when the external wrapper prints its own wait or end-of-task line in the tail of the pane.
export function wrapperOwnsPane(content: string, pattern: RegExp): boolean {
  return tailLines(content).some((line) => pattern.test(line));
}

export function paneKey(pane: PanePoint): string {
  return `${pane.session}:${pane.windowIndex}.${pane.paneIndex}#${pane.id}`;
}

function screenSignature(content: string): string {
  return createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
}

export function loadState(file: string): PanelState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PanelState> | null;
    return parsed && typeof parsed === 'object' && parsed.panes && typeof parsed.panes === 'object'
      ? (parsed as PanelState)
      : { panes: {} };
  } catch {
    return { panes: {} };
  }
}

export function saveState(file: string, state: PanelState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Pure decision on a provider reading. Takes limits with percentage >= 100; the unblock time is the latest
 * nextResetTime among them. Waits only if that reset is at most `windowMs` away and no weekly limit is
 * exhausted; otherwise the task ends. Missing reading, no exhausted limit or no positive reset: no wait.
 */
export function planQuotaWait(
  body: unknown,
  now: number,
  windowMs: number = QUOTA_WINDOW_MS,
  marginValueMs: number = DEFAULT_MARGIN_MS,
  weekUnit: number = DEFAULT_WEEK_LIMIT_UNIT,
): WaitPlan {
  const limits = limitsOf(body);
  if (!limits) return { wait: false, reason: 'no quota reading' };
  const exhausted = limits.filter((limit) => Number(limit?.percentage) >= EXHAUSTED_PERCENT);
  if (exhausted.length === 0) return { wait: false, reason: 'no exhausted limit' };
  if (exhausted.some((limit) => !(Number.isFinite(limit.nextResetTime) && (limit.nextResetTime as number) > 0))) {
    return { wait: false, reason: 'missing nextResetTime' };
  }
  const reset = Math.max(...exhausted.map((limit) => limit.nextResetTime as number));
  if (reset - now > windowMs) return { wait: false, reason: 'reset beyond the 5 h window', reset };
  if (exhausted.some((limit) => limit.unit === weekUnit)) {
    return { wait: false, reason: 'weekly or monthly limit exhausted', reset };
  }
  return { wait: true, reset, untilMs: reset + marginValueMs };
}

function limitsOf(body: unknown): QuotaLimit[] | null {
  const limits = (body as { data?: { limits?: unknown } } | null)?.data?.limits;
  if (Array.isArray(limits)) return limits as QuotaLimit[];
  return Array.isArray(body) ? (body as QuotaLimit[]) : null;
}

function planForReading(reading: QuotaReading | null, now: number, marginValueMs: number, weekUnit: number): WaitPlan {
  if (!reading || !reading.body) return { wait: false, reason: 'no quota reading' };
  return planQuotaWait(reading.body, now, QUOTA_WINDOW_MS, marginValueMs, weekUnit);
}

// Unit code of the weekly limit in the reading. Negative, fractional or non-numeric values fall back to the default.
function weekLimitUnit(env: PanelEnv): number {
  return nonNegativeInteger(env.OMC_PANEL_QUOTA_WEEK_UNIT, DEFAULT_WEEK_LIMIT_UNIT);
}

function iso(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'unknown';
}

// Pass time limit in milliseconds. A zero, negative or non-numeric value falls back to the default.
export function passLimitMs(env: PanelEnv): number {
  const text = String(env.OMC_PANEL_QUOTA_PASS_LIMIT_S ?? '').trim();
  const value = Number(text);
  return text !== '' && Number.isFinite(value) && value > 0 ? value * 1000 : DEFAULT_PASS_LIMIT_S * 1000;
}

// Resolves with TIME_LIMIT when `ms` runs out first. A rejection of `promise` still propagates; a late result is ignored.
function withTimeLimit<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIME_LIMIT> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = new Promise<typeof TIME_LIMIT>((resolve) => {
    timer = setTimeout(() => resolve(TIME_LIMIT), Math.max(0, ms));
  });
  promise.catch(() => {}); // a late rejection after the limit must not become unhandled
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer ?? undefined));
}

/**
 * One pass over the team panes. Mutates and returns `state`; the caller saves it.
 * With the switch off, returns `state` untouched and calls no dependency.
 */
export async function runPanelQuotaPass(
  state: PanelState,
  deps: PanelQuotaDeps,
  env: PanelEnv = process.env,
): Promise<PanelState> {
  if (!enabled(env)) return state;
  const now = deps.now();
  const max = waitsLimit(env);
  const codes = quotaCodes(env);
  const pattern = wrapperPattern(env);
  // Time limit of the whole pass, on a monotonic clock. Checked before every tmux call and every reading;
  // after the limit no keys are sent in this pass.
  const monotonic = deps.monotonic ?? (() => performance.now());
  const limitMs = passLimitMs(env);
  const deadline = monotonic() + limitMs;
  const timeLeft = (): number => deadline - monotonic();
  const stopForTimeLimit = (): void => deps.log(`quota pass stopped at its time limit (${limitMs / 1000} s): the remaining panes wait for the next pass; no keys are sent after this point`);
  const settleMs = marginMs(env);
  const weekUnit = weekLimitUnit(env);
  const prefix = sessionPrefix(env);
  const listedPanes = deps.listPanes(); // null if enumeration failed, [] if no panes
  // Preserve quota waits when pane enumeration fails.
  // Only delete entries if we have a successful enumeration.
  if (listedPanes !== null) {
    const panes = listedPanes.filter((pane) => String(pane.session).startsWith(prefix));
    const live = new Set(panes.map(paneKey));
    for (const key of Object.keys(state.panes)) {
      if (!live.has(key)) delete state.panes[key];
    }
  }
  const panes = (listedPanes || []).filter((pane) => String(pane.session).startsWith(prefix));

  for (const pane of panes) {
    if (timeLeft() <= 0) { stopForTimeLimit(); break; }
    const key = paneKey(pane);
    const content = deps.capture(pane, TAIL_LINES);
    if (content === null || content === undefined) continue;
    if (pattern && wrapperOwnsPane(content, pattern)) {
      deps.log(`pane ${key}: an external wrapper owns this error; the daemon sends no keys`);
      continue;
    }
    const sig = screenSignature(content);
    let entry = state.panes[key];

    if (entry && entry.state === 'waiting_quota') {
      if (entry.untilMs !== undefined && now < entry.untilMs) continue;
      // Strict capture right before the keys: the quota error must still be on screen for this pane identity.
      const fresh = deps.capture(pane, TAIL_LINES);
      // Keep quota waits retryable when the fresh capture fails.
      // If capture times out or returns null, retry on the next pass rather than marking as resumed.
      if (fresh === null || fresh === undefined) {
        deps.log(`pane ${key}: fresh capture failed at reset time; retry on next pass`);
        continue;
      }
      const freshErr = detectQuotaError(fresh, codes);
      if (!freshErr) {
        entry.state = 'resumed';
        entry.sig = screenSignature(fresh);
        entry.resumedAt = now;
        deps.log(`pane ${key}: no quota error on screen at reset time; no keys sent`);
        continue;
      }
      // Reclassify terminal quota errors before sending a resume.
      // The error code may have changed from resumable to non-resumable due to a user retry.
      if (codes.end.includes(freshErr.code)) {
        endQuota(entry, deps, now, `quota error ${freshErr.code} is non-resumable: no resume`, entry.resetMs ?? null);
        continue;
      }
      if (timeLeft() <= 0) { stopForTimeLimit(); break; }
      if (deps.sendContinue(pane)) {
        entry.state = 'resumed';
        entry.sig = screenSignature(fresh);
        entry.resumedAt = now;
        deps.log(`pane ${key}: resumed after the quota reset (wait ${entry.waits} of ${max})`);
        deps.journal({ ts: new Date(now).toISOString(), point: 'team-panel', pane: key, result: 'resume', state: 'resumed', attempt: entry.waits });
      } else {
        deps.log(`pane ${key}: resume keys not sent; retry on the next pass`);
      }
      continue;
    }

    if (entry && entry.state === 'resumed') {
      // Settle time after a resume, and an unchanged screen, mean the old error text is still visible: not a new error.
      if ((entry.resumedAt !== undefined && now - entry.resumedAt < settleMs) || sig === entry.sig) continue;
    }

    const err = detectQuotaError(content, codes);
    if (!err) continue;
    if (entry && entry.state === 'quota-ended' && sig === entry.sig) continue;

    if (!entry) {
      entry = { key, pane: pane.id, session: pane.session, windowIndex: pane.windowIndex, paneIndex: pane.paneIndex, waits: 0 };
      state.panes[key] = entry;
    }
    entry.sig = sig;
    entry.updatedAt = now;

    if (entry.waits >= max) {
      endQuota(entry, deps, now, `wait limit reached (${max})`, entry.resetMs ?? null);
      continue;
    }
    if (timeLeft() <= 0) { stopForTimeLimit(); break; }
    const reading = await withTimeLimit(deps.readQuota(), timeLeft());
    if (reading === TIME_LIMIT) { stopForTimeLimit(); break; }
    const plan = planForReading(reading, now, settleMs, weekUnit);
    if (codes.end.includes(err.code)) {
      // A non-resumable code is never resumed, whatever the reading says; the reset date goes to the coordinator.
      endQuota(entry, deps, now, `quota error ${err.code} is non-resumable: no resume`, plan.reset ?? null);
      continue;
    }
    if (plan.wait) {
      entry.waits += 1;
      entry.state = 'waiting_quota';
      entry.untilMs = plan.untilMs;
      entry.resetMs = plan.reset;
      deps.log(`pane ${key}: quota error ${err.code}; waiting until ${iso(plan.untilMs)} (wait ${entry.waits} of ${max})`);
      deps.journal({ ts: new Date(now).toISOString(), point: 'team-panel', pane: key, result: 'quota-wait', state: 'waiting_quota', attempt: entry.waits, reset_ms: plan.reset, wait_until_ms: plan.untilMs });
    } else {
      endQuota(entry, deps, now, plan.reason, plan.reset ?? null);
    }
  }
  return state;
}

// The task ends with class quota: the reset date goes to the journal and to the log for the coordinator.
function endQuota(entry: PanelEntry, deps: PanelQuotaDeps, now: number, reason: string, resetMs: number | null): void {
  entry.state = 'quota-ended';
  entry.resetMs = resetMs;
  entry.updatedAt = now;
  deps.log(`pane ${entry.key}: task ends with class quota (${reason}); reset ${iso(resetMs)}`);
  deps.journal({ ts: new Date(now).toISOString(), point: 'team-panel', pane: entry.key, result: 'end', class: 'quota', reason, reset_ms: resetMs, attempt: entry.waits });
}

/**
 * Real provider reading for the daemon: GET of OMC_PANEL_QUOTA_READ_URL with the key from OMC_PANEL_QUOTA_KEY_FILE.
 * Returns null (no wait) when the URL, the key file, the response or the HTTP status is unusable. The key
 * stays in the request header only; errors are not logged here.
 */
export async function readProviderQuota(env: PanelEnv = process.env): Promise<QuotaReading | null> {
  const url = quotaUrl(env.OMC_PANEL_QUOTA_READ_URL);
  if (!url || !env.OMC_PANEL_QUOTA_KEY_FILE) return null;
  const key = readKey(env.OMC_PANEL_QUOTA_KEY_FILE);
  if (!key) return null;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if ((body as { success?: unknown } | null)?.success === false) return null;
  return { body };
}

function quotaUrl(text: string | undefined): URL | null {
  try {
    const url = new URL(String(text ?? ''));
    const loopback = LOOPBACK_HOSTS.includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
  } catch {
    return null;
  }
}

function readKey(file: string): string | null {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return key === '' ? null : key;
  } catch {
    return null;
  }
}

function appendJournal(env: PanelEnv, row: Journal): void {
  if (!env.OMC_PANEL_QUOTA_JOURNAL) return;
  try {
    mkdirSync(dirname(env.OMC_PANEL_QUOTA_JOURNAL), { recursive: true, mode: 0o700 });
    appendFileSync(env.OMC_PANEL_QUOTA_JOURNAL, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // A missing journal does not stop the daemon; the state file and the log still show the decision.
  }
}

/**
 * Entry point for the daemon: one pass per poll. Returns the state, or null when the switch is off
 * (no reads, no tmux calls, no file writes).
 */
export async function runDaemonPanelQuotaPass({
  stateDir,
  env = process.env,
  tmux,
  readQuota,
  log = () => {},
  now = () => Date.now(),
  monotonic,
}: {
  stateDir: string;
  env?: PanelEnv;
  tmux: PanelTmux;
  readQuota?: () => Promise<QuotaReading | null>;
  log?: (text: string) => void;
  now?: () => number;
  monotonic?: () => number;
}): Promise<PanelState | null> {
  if (!enabled(env)) return null;
  const file = env.OMC_PANEL_QUOTA_STATE || join(stateDir, STATE_FILE_NAME);
  const state = loadState(file);
  const deps: PanelQuotaDeps = {
    now,
    monotonic,
    listPanes: () => tmux.listPanes(),
    capture: (pane, lines) => tmux.capture(pane, lines),
    sendContinue: (pane) => tmux.sendContinue(pane),
    readQuota: readQuota ?? (() => readProviderQuota(env)),
    log,
    journal: (row) => appendJournal(env, row),
  };
  await runPanelQuotaPass(state, deps, env);
  saveState(file, state);
  return state;
}
