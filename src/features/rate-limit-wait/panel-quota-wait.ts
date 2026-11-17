/**
 * Opt-in quota wait for the worker panels of `omc team`.
 *
 * Switch: OMC_PANEL_QUOTA_WAIT=1 (off by default; with the switch off nothing is read, nothing is
 * sent and no state is written).
 *
 * The rate-limit-wait daemon calls runDaemonPanelQuotaPass once per poll. A team pane whose last lines
 * show a provider quota error waits until the reset of the 5 h window plus a margin, then receives one
 * continue key. A non-resumable code, a reset beyond the window, an exhausted weekly limit, or the wait
 * limit ends the wait of that pane with class "quota" and no key is sent; the reset date goes to the log and
 * to the optional journal. The pass does not change the state of a team task: a task claimed by a pane that
 * ended its wait stays as the team runtime has it, and the log and the journal are where the end is recorded.
 *
 * Before a continue key is sent the pass looks at the pane again: the quota error must still be on the screen,
 * no wrapper may own the wait, the code must not have turned non-resumable, and the provider must still run
 * in the pane (a pane whose provider exited shows the user's shell, and the key would be typed into it).
 *
 * The key cannot be taken back, so the intent to send it is recorded first: the pane goes to state "resuming"
 * and the state is saved (deps.persist) before the key is sent. A daemon that stops after that point finds the
 * "resuming" entry on its next pass and does not send a second key: it marks the pane "resumed" and says in
 * the log and the journal that the delivery is unconfirmed. If the intent cannot be saved, no key is sent.
 * The key has three outcomes. Delivered: the pane is "resumed". Not attempted (tmux refused it, or did not start):
 * the pane goes back to "waiting_quota" and that is saved, so the key may be sent again. Unconfirmed (the text was
 * typed and its Enter failed, or a call timed out): the key may sit in the pane's input, so it is never sent again.
 * The pane is "resumed" with the flag `unconfirmed`, the log and the journal (result "resume-unconfirmed") say that
 * the pane needs a look, and no key goes to it while the quota error is still on its screen, whatever the tail looks
 * like. A restart that finds the saved intent ends in the same state. A code that ends a pane (a configured
 * end code, a wait limit, a weekly limit) needs no key and is decided on the screen first: it is not held back by
 * a slow reading, which only supplies the reset date for the log.
 *
 * One pass has one time limit (OMC_PANEL_QUOTA_PASS_LIMIT_S), shared by every pane. Panes that wait come first, then the
 * others. A wait whose reset has not come needs no capture and no time, a pane resumed a moment ago is not captured while
 * the old error text can be on its screen, and a due wait is captured once, right before its key. A pass that runs out of
 * time saves a cursor: the next pass starts after the last pane this one worked on, so a pane that used up the time goes
 * to the end of the next pass and a pane that was not reached goes to its start, for waiting and other panes alike.
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
 *   OMC_PANEL_QUOTA_WAIT_MAX     waits per pane before its wait ends ([3])
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
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';

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

/**
 * Outcome of the continue key, the one effect of a pass that cannot be taken back: `delivered` (text and Enter went
 * in), `not_attempted` (nothing was sent, so the key may be sent again), `unconfirmed` (the text may be typed in
 * the pane without its Enter, or a call timed out: it is never sent again).
 */
export type ResumeDelivery = 'delivered' | 'not_attempted' | 'unconfirmed';

export interface PanelTmux {
  /** The panes of the tmux server, or null when the inventory cannot be read (tmux missing, server unreachable, timeout). */
  listPanes(): PanePoint[] | null;
  capture(pane: PanePoint, lines: number): string | null;
  sendContinue(pane: PanePoint): ResumeDelivery;
  /** Whether the provider still runs in the pane: false for a dead pane or a shell in the foreground, null when it cannot be told. */
  providerRunning(pane: PanePoint): boolean | null;
}

export interface PanelEntry {
  key: string;
  pane: string;
  session: string;
  windowIndex: number;
  paneIndex: number;
  waits: number;
  /** "resuming": the continue key is about to be sent, or was sent without the pass finishing; it is never sent again. */
  state?: 'waiting_quota' | 'resuming' | 'resumed' | 'quota-ended';
  /**
   * Set on a "resumed" pane whose continue key may have been typed without being submitted (a partial send, a timeout,
   * or a daemon that stopped between the intent and the result). No key is sent to the pane while the quota error is
   * still on its screen: a second key would be typed after the first. Cleared when the error is gone.
   */
  unconfirmed?: boolean;
  sig?: string | null;
  updatedAt?: number;
  resumedAt?: number;
  untilMs?: number;
  resetMs?: number | null;
}

export interface PanelState {
  panes: Record<string, PanelEntry>;
  /** Key of the pane the next pass starts at, after a pass that ran out of time (see runPanelQuotaPass). */
  cursor?: string;
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
  listPanes(): PanePoint[] | null;
  capture(pane: PanePoint, lines: number): string | null | undefined;
  sendContinue(pane: PanePoint): ResumeDelivery;
  providerRunning(pane: PanePoint): boolean | null;
  readQuota(): Promise<QuotaReading | null>;
  log(text: string): void;
  journal(row: Journal): void;
  /** Saves the state durably. Called before an effect that cannot be undone; a throw stops that effect. */
  persist?(state: PanelState): void;
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
// When multiple codes are present, returns the last (latest) one.
export function detectQuotaError(content: string, codes: QuotaCodes): { code: number } | null {
  const pattern = quotaErrorPattern(codes);
  if (!pattern) return null;
  const tail = tailLines(content).join('');
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  // Create a fresh regex with global flag to find all matches
  const globalPattern = new RegExp(pattern.source, 'g');
  while ((match = globalPattern.exec(tail)) !== null) {
    lastMatch = match;
  }
  return lastMatch ? { code: Number(lastMatch[1]) } : null;
}

// True when the external wrapper prints its own wait or end-of-task line in the tail of the pane.
export function wrapperOwnsPane(content: string, pattern: RegExp): boolean {
  return tailLines(content).some((line) => pattern.test(line));
}

// The tmux pane id is the identity of a pane: it stays the same when the pane moves to another window, changes
// its index or when its session is renamed. Session, window index and pane index are refreshed on the entry at
// every pass, not part of the key.
export function paneKey(pane: PanePoint): string {
  return pane.id;
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
  // Random temporary name, exclusive creation and an atomic rename: no predictable name for a link to take over.
  atomicWriteFileSync(file, JSON.stringify(state) + '\n');
}

/**
 * Pure decision on a provider reading. Takes limits with percentage >= 100; the unblock time is the latest
 * nextResetTime among them. Waits only if that reset is at most `windowMs` away and no weekly limit is
 * exhausted; otherwise the wait ends. Missing reading, no exhausted limit or no positive reset: no wait.
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
 * One pass over the team panes. Mutates and returns `state`; the caller saves it at the end of the pass, and
 * `deps.persist` saves it before a continue key is sent (see the header).
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
  // Time limit of the whole pass, on a monotonic clock: the only budget of a pass, shared by every pane. It is checked
  // before each pane that needs a tmux call, before every call after the first of a pane, and before every reading
  // (a reading is also cut off when the time runs out). A tmux call itself is not cut short, so a pass can end later
  // than the limit by one call (a capture waits up to 5 s). After the limit no key is sent in this pass.
  const monotonic = deps.monotonic ?? (() => performance.now());
  const limitMs = passLimitMs(env);
  const deadline = monotonic() + limitMs;
  const timeLeft = (): number => deadline - monotonic();
  const stopForTimeLimit = (): void => deps.log(`quota pass stopped at its time limit (${limitMs / 1000} s): the remaining panes wait for the next pass; no keys are sent after this point`);
  const settleMs = marginMs(env);
  const weekUnit = weekLimitUnit(env);
  const prefix = sessionPrefix(env);
  // A resume that an earlier pass recorded before its key, and did not finish, is not repeated.
  for (const [key, entry] of Object.entries(state.panes)) {
    if (entry.state !== 'resuming') continue;
    entry.resumedAt = entry.resumedAt ?? now;
    markResumeUnconfirmed(entry, key, deps, now, 'a resume was recorded before the daemon stopped; no second key is sent, and whether the first one arrived is unknown');
  }
  const listedPanes = deps.listPanes();
  if (listedPanes === null) {
    // An inventory that cannot be read is not an empty one: the saved waits stay and nothing is scanned or sent.
    if (Object.keys(state.panes).length > 0) {
      deps.log('pane inventory unavailable: the saved quota waits are kept and nothing is scanned in this pass');
    }
    return state;
  }
  const panes = listedPanes.filter((pane) => String(pane.session).startsWith(prefix));
  const live = new Set(panes.map(paneKey));
  for (const key of Object.keys(state.panes)) {
    if (!live.has(key)) delete state.panes[key];
  }
  // One sequence for the whole pass: panes that already wait come first (their due resumes need no reading and must
  // not queue behind a new detection that runs out of time), then the others, each group in tmux order. A pass that ran
  // out of time leaves the cursor at the pane where the next pass starts, so the order rotates over waiting and other
  // panes alike and no pane is always the first to be tried or always the one that is never reached.
  const waiting = panes.filter((pane) => state.panes[paneKey(pane)]?.state === 'waiting_quota');
  const others = panes.filter((pane) => state.panes[paneKey(pane)]?.state !== 'waiting_quota');
  const sequence = [...waiting, ...others];
  const startAt = sequence.findIndex((pane) => paneKey(pane) === state.cursor);
  const ordered = startAt > 0 ? [...sequence.slice(startAt), ...sequence.slice(0, startAt)] : sequence;
  delete state.cursor;
  // Where the time limit ended the pass: the index in `ordered`, and whether that pane was already worked on.
  let limitedAt: { index: number; attempted: boolean } | null = null;

  for (let index = 0; index < ordered.length; index++) {
    const pane = ordered[index];
    const key = paneKey(pane);
    let entry = state.panes[key];
    if (entry) {
      // The key is the pane id; where the pane sits now is refreshed, not matched.
      entry.session = pane.session;
      entry.windowIndex = pane.windowIndex;
      entry.paneIndex = pane.paneIndex;
    }
    // A pane that needs nothing from this pass costs no time and no tmux call: a wait whose reset has not come, and a
    // pane resumed a moment ago whose old error text is still on the screen.
    if (entry?.state === 'waiting_quota' && entry.untilMs !== undefined && now < entry.untilMs) continue;
    if (entry?.state === 'resumed' && !entry.unconfirmed && entry.resumedAt !== undefined && now - entry.resumedAt < settleMs) continue;
    if (timeLeft() <= 0) { stopForTimeLimit(); limitedAt = { index, attempted: false }; break; }

    if (entry && entry.state === 'waiting_quota') {
      // The reset has come. One capture, taken right before the key, decides everything the key depends on: the quota
      // error must still be on the screen of this pane identity.
      const fresh = deps.capture(pane, TAIL_LINES);
      // An unreadable capture is not a reason to close the wait: retry on the next pass.
      if (fresh === null || fresh === undefined) {
        deps.log(`pane ${key}: capture failed at reset time; retry on next pass`);
        continue;
      }
      if (pattern && wrapperOwnsPane(fresh, pattern)) {
        deps.log(`pane ${key}: an external wrapper owns this error at reset time; the daemon sends no keys`);
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
      // The error code may have turned non-resumable since the wait began (for example after a retry by the user).
      if (codes.end.includes(freshErr.code)) {
        endQuota(entry, deps, now, `quota error ${freshErr.code} is non-resumable: no resume`, entry.resetMs ?? null);
        continue;
      }
      // A capture that used up the time leaves nothing for the provider check: this wait is tried again later, after the
      // panes that were not reached.
      if (timeLeft() <= 0) { stopForTimeLimit(); limitedAt = { index, attempted: true }; break; }
      // After the provider exits the pane shows the user's shell, and the old error is still in its scrollback.
      const running = deps.providerRunning(pane);
      if (running === null) {
        deps.log(`pane ${key}: cannot tell whether the provider still runs in the pane; retry on next pass`);
        continue;
      }
      if (!running) {
        entry.state = 'resumed';
        entry.sig = screenSignature(fresh);
        entry.resumedAt = now;
        deps.log(`pane ${key}: the provider no longer runs in the pane; no keys sent`);
        continue;
      }
      if (timeLeft() <= 0) { stopForTimeLimit(); limitedAt = { index, attempted: true }; break; }
      // The intent goes to disk before the key goes to the pane. A key that cannot be taken back must not depend on
      // a save that comes after it.
      const before = { state: entry.state, sig: entry.sig, resumedAt: entry.resumedAt };
      entry.state = 'resuming';
      entry.sig = screenSignature(fresh);
      entry.resumedAt = now;
      try {
        deps.persist?.(state);
      } catch (error) {
        Object.assign(entry, before);
        deps.log(`pane ${key}: the resume could not be recorded (${error instanceof Error ? error.message : String(error)}); no key is sent; retry on the next pass`);
        continue;
      }
      const delivery = deps.sendContinue(pane);
      if (delivery === 'delivered') {
        entry.state = 'resumed';
        deps.log(`pane ${key}: resumed after the quota reset (wait ${entry.waits} of ${max})`);
        deps.journal({ ts: new Date(now).toISOString(), point: 'team-panel', pane: key, result: 'resume', state: 'resumed', attempt: entry.waits });
      } else if (delivery === 'unconfirmed') {
        // Part of the key may be in the pane (the text without its Enter) or the call did not answer: it is never sent
        // again. The intent saved above stays as the record of the attempt, and the pane is held for a manual look.
        markResumeUnconfirmed(entry, key, deps, now, 'the continue key may have reached the pane only in part; no second key is sent');
      } else {
        // Nothing was sent: the pane waits again, and that is recorded, so that a restart retries it.
        Object.assign(entry, before);
        deps.log(`pane ${key}: resume keys not sent; retry on the next pass`);
        try {
          deps.persist?.(state);
        } catch (error) {
          deps.log(`pane ${key}: the wait could not be saved again (${error instanceof Error ? error.message : String(error)}); a restart will not repeat the resume`);
        }
      }
      continue;
    }

    const content = deps.capture(pane, TAIL_LINES);
    if (content === null || content === undefined) continue;
    if (pattern && wrapperOwnsPane(content, pattern)) {
      deps.log(`pane ${key}: an external wrapper owns this error; the daemon sends no keys`);
      continue;
    }
    const sig = screenSignature(content);

    if (entry?.unconfirmed) {
      // The key may sit typed in the pane's input: nothing is sent while the error shows, however the tail changed.
      if (detectQuotaError(content, codes)) continue;
      delete entry.unconfirmed;
      entry.sig = null;
      deps.log(`pane ${key}: the quota error is gone from the screen; the unconfirmed resume is closed`);
      continue;
    }

    // An unchanged screen after a resume means the old error text is still visible: not a new error. (A pane inside
    // its settle time was passed over before the capture.)
    if (entry && entry.state === 'resumed' && sig === entry.sig) continue;

    const err = detectQuotaError(content, codes);
    if (!err) {
      // A settled pane that shows no quota error ends the last event: the next error, even one that renders the
      // same tail, is a new event and must not be taken for the old one.
      if (entry && (entry.state === 'resumed' || entry.state === 'quota-ended')) entry.sig = null;
      continue;
    }
    if (entry && entry.state === 'quota-ended' && sig === entry.sig) continue;

    if (!entry) {
      entry = { key, pane: pane.id, session: pane.session, windowIndex: pane.windowIndex, paneIndex: pane.paneIndex, waits: 0 };
      state.panes[key] = entry;
    }
    // The screen is recorded as the last event only once the event is acted on: a pass that runs out of time on it
    // leaves the pane to be looked at again, and does not make the next pass take the event for an old one.
    const target = entry;
    const seen = (): void => { target.sig = sig; target.updatedAt = now; };

    if (codes.end.includes(err.code)) {
      // A non-resumable code is never resumed, whatever the reading says, so the pane is decided here and the wait
      // ends in this pass. The reading only supplies the reset date for the coordinator: a reading that does not
      // come back within the pass leaves the date unknown, and the pass stops after this pane.
      let resetMs: number | null = null;
      let outOfTime = timeLeft() <= 0;
      if (!outOfTime) {
        const reading = await withTimeLimit(deps.readQuota(), timeLeft());
        if (reading === TIME_LIMIT) outOfTime = true;
        else resetMs = planForReading(reading, now, settleMs, weekUnit).reset ?? null;
      }
      seen();
      endQuota(entry, deps, now, `quota error ${err.code} is non-resumable: no resume`, resetMs);
      if (outOfTime) { stopForTimeLimit(); limitedAt = { index, attempted: true }; break; }
      continue;
    }
    if (entry.waits >= max) {
      seen();
      endQuota(entry, deps, now, `wait limit reached (${max})`, entry.resetMs ?? null);
      continue;
    }
    if (timeLeft() <= 0) { stopForTimeLimit(); limitedAt = { index, attempted: false }; break; }
    const reading = await withTimeLimit(deps.readQuota(), timeLeft());
    if (reading === TIME_LIMIT) { stopForTimeLimit(); limitedAt = { index, attempted: true }; break; }
    const plan = planForReading(reading, now, settleMs, weekUnit);
    seen();
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
  if (limitedAt !== null) {
    // The next pass starts after the last pane this one worked on, wrapping to the first: a pane that used up the time
    // goes to the end of the next pass, and a pane that was not reached goes to its start.
    const reached = limitedAt.index + (limitedAt.attempted ? 1 : 0);
    state.cursor = paneKey(ordered[reached % ordered.length]);
  }
  return state;
}

// A resume whose delivery is not known: the pane is settled as "resumed", held against any further key (see
// PanelEntry.unconfirmed), and the log and the journal say that someone must look at the pane.
function markResumeUnconfirmed(entry: PanelEntry, key: string, deps: PanelQuotaDeps, now: number, why: string): void {
  entry.state = 'resumed';
  entry.unconfirmed = true;
  deps.log(`pane ${key}: ${why}`);
  deps.journal({ ts: new Date(now).toISOString(), point: 'team-panel', pane: key, result: 'resume-unconfirmed', state: 'resumed', attempt: entry.waits });
}

// The wait of this pane ends with class quota and the pane is left alone: the reset date goes to the journal and
// to the log for the coordinator. No team task state is written here.
function endQuota(entry: PanelEntry, deps: PanelQuotaDeps, now: number, reason: string, resetMs: number | null): void {
  entry.state = 'quota-ended';
  entry.resetMs = resetMs;
  entry.updatedAt = now;
  deps.log(`pane ${entry.key}: wait ends with class quota, no keys sent (${reason}); reset ${iso(resetMs)}`);
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
    providerRunning: (pane) => tmux.providerRunning(pane),
    readQuota: readQuota ?? (() => readProviderQuota(env)),
    log,
    journal: (row) => appendJournal(env, row),
    persist: (saved) => saveState(file, saved),
  };
  await runPanelQuotaPass(state, deps, env);
  saveState(file, state);
  return state;
}
