/**
 * Run ledger (P2 Part A, contract: docs/design/P2-RUN-LEDGER-AND-INTAKE-PLAN.md).
 *
 * Append-only JSONL at `<omcRoot>/state/runs/ledger.jsonl` recording the
 * lifecycle edges of watched unattended modes. Mode state files are wiped by
 * cancel BEFORE the Stop event fires, so a durable trace that survives cancel
 * is the prerequisite for any closeout reconciliation: without this ledger,
 * "did the run write its closeout?" is unanswerable after the fact.
 *
 * Evidence by contract: append failures are swallowed. The ledger is
 * promotion/audit evidence — a broken ledger must never break the state
 * write or clear it observes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

/** The unattended modes whose lifecycle edges are recorded. */
export const WATCHED_RUN_MODES = ['ralph', 'autopilot', 'team', 'ultragoal'] as const;

export type WatchedRunMode = (typeof WATCHED_RUN_MODES)[number];

export interface RunLedgerEntry {
  ts: string;
  run: string;
  sessionId?: string;
  event: 'start' | 'end';
  outcome?: 'running' | 'completed' | 'failed' | 'cancelled';
  closeoutWritten?: boolean;
}

const LEDGER_TAIL_LINES = 1000;

export function isWatchedRunMode(modeName: string): modeName is WatchedRunMode {
  return (WATCHED_RUN_MODES as readonly string[]).includes(modeName);
}

function ledgerPath(omcRoot: string): string {
  return join(omcRoot, 'state', 'runs', 'ledger.jsonl');
}

/** True when the mode's notepad gained a write after the run started. */
export function closeoutWrittenFor(omcRoot: string, mode: string, startedAt: string | undefined): boolean {
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return false;
  const started = Date.parse(startedAt);
  for (const name of ['problems.md', 'issues.md']) {
    const notepad = join(omcRoot, 'notepads', mode, name);
    try {
      if (existsSync(notepad) && statSync(notepad).mtimeMs > started) return true;
    } catch {
      // unreadable notepad cannot prove a closeout
    }
  }
  return false;
}

/**
 * Append one lifecycle edge. sessionId is included when the state file is
 * session-scoped so the reconciler can attribute the entry.
 */
export function appendRunLedger(omcRoot: string, entry: RunLedgerEntry): void {
  try {
    const dir = join(omcRoot, 'state', 'runs');
    mkdirSync(dir, { recursive: true });
    const path = ledgerPath(omcRoot);
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // evidence by contract
  }
}

function rotateIfNeeded(path: string): void {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return;
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < LEDGER_TAIL_LINES) return;
    // Append all lines to .1 for archival, then clear main for fresh appends.
    // This keeps the total ledger bounded: .1 has rotated batches, main has recent entries.
    appendFileSync(`${path}.1`, `${lines.join('\n')}\n`, 'utf8');
    writeFileSync(path, '', 'utf8');
  } catch {
    // rotation is best-effort; appends tolerate a missing or locked file
  }
}

/**
 * Observe a successful state write: append a `start` edge when a watched
 * mode's state becomes active. Idempotent per process — repeated writes of
 * an already-active state do not duplicate the start edge.
 */
export function observeModeStateWrite(omcRoot: string, filePath: string, state: Record<string, unknown>): void {
  try {
    const mode = modeFromStatePath(filePath);
    if (!mode || !isWatchedRunMode(mode)) return;
    if (state?.active !== true) return;
    const key = filePath;
    if (activeLoggedPaths.get(key)) return;
    activeLoggedPaths.set(key, true);
    appendRunLedger(omcRoot, {
      ts: new Date().toISOString(),
      run: mode,
      sessionId: sessionIdFromStatePath(filePath),
      event: 'start',
      outcome: 'running',
    });
  } catch {
    // evidence by contract
  }
}

/**
 * Observe a successful state clear: append an `end` edge when a watched
 * mode's previously-active state is removed, carrying the outcome and the
 * closeout flag computed against the run's notepad.
 */
export function observeModeStateClear(omcRoot: string, filePath: string, previousState: Record<string, unknown> | null): void {
  try {
    const mode = modeFromStatePath(filePath);
    if (!mode || !isWatchedRunMode(mode)) return;
    if (!previousState || previousState.active !== true) return;
    if (previousState.active === true) activeLoggedPaths.delete(filePath);
    appendRunLedger(omcRoot, {
      ts: new Date().toISOString(),
      run: mode,
      sessionId: sessionIdFromStatePath(filePath),
      event: 'end',
      outcome: typeof previousState.current_phase === 'string' && /complete|done/i.test(previousState.current_phase)
        ? 'completed'
        : 'cancelled',
      closeoutWritten: closeoutWrittenFor(omcRoot, mode, typeof previousState.started_at === 'string' ? previousState.started_at : undefined),
    });
  } catch {
    // evidence by contract
  }
}

function modeFromStatePath(filePath: string): string | null {
  const match = filePath.replaceAll('\\', '/').match(/\/([a-z][a-z0-9-]+)-state\.json$/);
  return match?.[1] ?? null;
}

function sessionIdFromStatePath(filePath: string): string | undefined {
  const match = filePath.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)(?:\/|$)/);
  return match?.[1];
}

const activeLoggedPaths = new Map<string, boolean>();
