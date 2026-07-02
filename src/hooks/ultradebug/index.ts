/**
 * UltraDebug Hook
 *
 * Stateful, resumable bug-fixing loop driven by the OMC persistence engine (the
 * "ralph engine"). This module owns the per-session state I/O, iteration
 * counting, the completion-promise contract, and the Stop-hook continuation
 * prompt. The Stop-hook integration itself (checkUltradebug) lives in
 * persistent-mode/index.ts and reuses these helpers, mirroring ralph.
 *
 * Design reference: `.omc/plans/ultradebug-design.md` (§5A, §6, §7, D1–D7).
 * Driver contract: `skills/ultradebug/SKILL.md` <Driver>/<Exit_Conditions>.
 */

import {
  writeModeState,
  readModeState,
  clearModeStateFile,
} from "../../lib/mode-state-io.js";

/**
 * Completion promise. The loop prints this EXACT string only once the original
 * repro passes and `/ultraqa` returned PASS. Contract tests grep for it — do
 * not change without updating SKILL.md and the design doc.
 */
export const ULTRADEBUG_COMPLETE_PROMISE = "ULTRADEBUG_COMPLETE";

/** Default iteration bound (SKILL.md DRIVER CONTRACT: max_iterations default 8). */
export const ULTRADEBUG_DEFAULT_MAX_ITERATIONS = 8;

export type UltradebugStatus =
  | "investigating"
  | "fixing"
  | "verifying"
  | "uat_pending"
  | "complete";

/**
 * Per-session ultradebug state (design §6). Only the loop-control fields are
 * typed explicitly; the skill also persists `path`, `effort`, `hypotheses[]`,
 * `root_cause`, `plan`, `changed_files[]`, `commit`, `verify`, `uat`, and
 * `head_before`. Those are preserved verbatim via the index signature — the
 * driver never needs to read them.
 */
export interface UltradebugState {
  /** Whether the loop is currently active. */
  active: boolean;
  /** Current iteration number. */
  iteration: number;
  /** Maximum iterations before the loop hard-stops (kept for --resume). */
  max_iterations: number;
  /** ISO timestamp when the session started. */
  started_at: string;
  /** Session id the loop is bound to. */
  session_id?: string;
  /** Project path for isolation. */
  project_path?: string;
  /** Current phase in the state machine (design §5). */
  status?: UltradebugStatus;
  /** One-line bug summary. */
  title?: string;
  /** Verbatim bug description. */
  issue?: string;
  [key: string]: unknown;
}

/**
 * Read ultradebug session state from disk.
 * Enforces the same lenient session-identity check ralph uses: reject only when
 * BOTH the state file and the caller carry defined, differing session ids.
 */
export function readUltradebugState(
  directory: string,
  sessionId?: string,
): UltradebugState | null {
  const state = readModeState<UltradebugState>("ultradebug", directory, sessionId);

  if (state && sessionId && state.session_id && state.session_id !== sessionId) {
    return null;
  }

  return state;
}

/**
 * Write ultradebug session state to disk.
 */
export function writeUltradebugState(
  directory: string,
  state: UltradebugState,
  sessionId?: string,
): boolean {
  return writeModeState(
    "ultradebug",
    state as unknown as Record<string, unknown>,
    directory,
    sessionId,
  );
}

/**
 * Clear (delete) ultradebug session state. Used on genuine completion and by
 * `/oh-my-claudecode:cancel`.
 */
export function clearUltradebugState(
  directory: string,
  sessionId?: string,
): boolean {
  return clearModeStateFile("ultradebug", directory, sessionId);
}

/**
 * Increment the ultradebug iteration counter and persist it.
 * Returns the updated state, or null when there is no active session.
 */
export function incrementUltradebugIteration(
  directory: string,
  sessionId?: string,
): UltradebugState | null {
  const state = readUltradebugState(directory, sessionId);

  if (!state || !state.active) {
    return null;
  }

  state.iteration += 1;

  if (writeUltradebugState(directory, state, sessionId)) {
    return state;
  }

  return null;
}

/**
 * Does assistant-authored text carry the completion promise? The Stop-hook
 * caller must scan ONLY assistant turns — the continuation prompt below quotes
 * the promise string, so scanning injected (user-role) prompts would false-positive.
 */
export function detectUltradebugComplete(text: string): boolean {
  return typeof text === "string" && text.includes(ULTRADEBUG_COMPLETE_PROMISE);
}

/**
 * Build the Stop-hook continuation prompt. The `[ULTRADEBUG - ITERATION n/max]`
 * header is the SKILL.md activation header and IS the continuation prompt —
 * contract tests grep for it, so keep it byte-exact.
 */
export function buildUltradebugContinuationPrompt(
  iteration: number,
  maxIterations: number,
): string {
  return `<ultradebug-continuation>
[ULTRADEBUG - ITERATION ${iteration}/${maxIterations}]

Your previous attempt did not output the completion promise \`${ULTRADEBUG_COMPLETE_PROMISE}\`.
Continue the debug loop from the current session status.

CRITICAL INSTRUCTIONS:
1. Resume from the persisted session status (investigate -> fix -> verify -> UAT).
2. Preserve every hypothesis (confirmed AND rejected) so resume never re-investigates a dead end.
3. Only print \`${ULTRADEBUG_COMPLETE_PROMISE}\` once the original repro passes AND /ultraqa returned PASS.
4. Never print the promise to escape a hard iteration — report the blocker instead.
</ultradebug-continuation>

---

`;
}
