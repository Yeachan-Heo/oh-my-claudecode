/**
 * Nikoflow Hook
 *
 * Phase-gated work loop implementing the "Niko Flow v2.1" methodology
 * (grilling → ADR → PRD → tickets → execute → verify) as an enforced
 * Stop-hook state machine. Sibling of the ralph mode; reuses the generic
 * mode-state IO and (later tickets) ralph's PRD + verifier machinery.
 *
 * TSK-001: skeleton — activation, state, depth parsing, cancel, Stop-block.
 * Phase gating + gates land in TSK-002+.
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, unlinkSync } from "fs";
import {
  writeModeState,
  readModeState,
  clearModeStateFile,
} from "../../lib/mode-state-io.js";
import { atomicWriteJsonSync } from "../../lib/atomic-write.js";
import { resolveSessionStatePath } from "../../lib/worktree-paths.js";

export const NIKOFLOW_DEPTHS = ["tactical", "standard", "deep"] as const;
export type NikoflowDepth = (typeof NIKOFLOW_DEPTHS)[number];

/**
 * Per-role model routing. Each value is a model spec that the prompts render
 * into a Task/Agent subagent invocation — so the reviewer is ALWAYS a Task
 * subagent (the gate detector already accepts those), and GPT-5.5 rides in via
 * a Codex-backed agent rather than a raw shell command.
 */
export interface NikoflowRoles {
  /** Who writes prod code during Execute. */
  executor: string;
  /** Who advises on ADR / architecture. */
  architect: string;
  /** Independent reviewer for the per-ticket Execute gate. */
  reviewer: string;
  /** Independent reviewer for the Verify convergence gate. */
  verifier: string;
  /** Divergent-opinion panel consulted during Grilling (design dueling). */
  panel: string[];
}

/** Native Anthropic models usable directly as Task `model=`. */
export const NIKOFLOW_NATIVE_MODELS = ["sonnet", "opus", "haiku", "fable"] as const;
/** Model specs that route through a Codex-backed Task agent (GPT-5.5 xhigh). */
export const NIKOFLOW_CODEX_SPECS = ["codex", "gpt-5.5", "gpt5.5"] as const;

/** Fallback chain when a preferred model is unavailable. */
export const NIKOFLOW_MODEL_FALLBACK: Record<string, string> = { fable: "opus" };

/** Default routing (user spec): Sonnet 5 executes, Fable 5 architects+reviews
 *  (→ Opus 4.8 fallback), GPT-5.5 xhigh joins QA + the grilling panel. */
export const NIKOFLOW_DEFAULT_ROLES: NikoflowRoles = {
  executor: "sonnet",
  architect: "fable",
  reviewer: "fable",
  verifier: "fable",
  panel: ["fable", "gpt-5.5"],
};

/**
 * Phase lists per depth tier — data, not code. The Stop-hook state machine
 * iterates `phases[]` by index; the tier only selects which phases fire.
 */
export const NIKOFLOW_PHASES: Record<NikoflowDepth, string[]> = {
  tactical: ["interview", "execute", "verify"],
  standard: ["interview", "adr", "prd", "tickets", "execute", "verify"],
  deep: ["interview", "adr", "prd", "tickets", "execute", "verify"],
};

export interface NikoflowState {
  /** Whether the loop is currently active */
  active: boolean;
  /** Current iteration number */
  iteration: number;
  /** When the loop started */
  started_at: string;
  /** Refreshed on every Stop-hook iteration so a live long session is not
   *  treated as stale; a crashed/legacy file goes stale on its own. */
  last_checked_at?: string;
  /** The original task prompt (control flags stripped) */
  prompt: string;
  /** Session ID the loop is bound to */
  session_id?: string;
  /** Project path for isolation */
  project_path?: string;
  /** Selected depth tier, or null until chosen during interview */
  depth: NikoflowDepth | null;
  /** Materialized phase list for the chosen depth (empty until depth set) */
  phases: string[];
  /** Index into phases[] of the current phase */
  phase_index: number;
  /** Whether deep-tier property-based-testing obligation applies */
  pbt_enabled?: boolean;
  /** Per-role model routing (executor/architect/reviewer/verifier/panel). */
  roles?: NikoflowRoles;

  // --- Gate correlation (TSK-003) ---
  /** Correlation id the current gate's confirmation tag must carry. */
  request_id?: string;
  /** The phase (or "depth") the current request_id was minted for. */
  awaiting_gate?: string;
  /** When the current request_id was minted (ISO). */
  gate_request_minted_at?: string;
  /** Timestamp of the most recent real UserPromptSubmit (ISO). Used to prove a
   *  human actually replied after a gate was requested (anti-self-approval). */
  last_user_prompt_at?: string;
  /** Number of failed verify-review passes (loop-review convergence, TSK-006). */
  verify_pass?: number;
  /** Consecutive verify Stops with NO parseable reviewer verdict (livelock guard). */
  verify_no_verdict?: number;
  /** The ticket the execute-stall counter is tracking. */
  execute_stall_ticket?: string;
  /** Consecutive execute Stops on the same ticket with no reviewer verdict. */
  execute_stall?: number;
}

/** Verify gate: reviewer score at/above this passes. */
export const NIKOFLOW_VERIFY_SCORE_THRESHOLD = 9.5;
/** Verify gate: after this many failed passes, escalate to the user. */
export const NIKOFLOW_VERIFY_MAX_PASSES = 6;
/** Verify: after this many Stops with NO parseable verdict, escalate (livelock guard, R1). */
export const NIKOFLOW_VERIFY_MAX_NO_VERDICT = 8;
/** Execute: after this many Stops on one ticket with no reviewer verdict, surface it (R1). */
export const NIKOFLOW_EXECUTE_MAX_STALL = 15;

export interface NikoflowLoopOptions {
  depth?: NikoflowDepth;
}

export interface NikoflowLoopHook {
  startLoop: (
    sessionId: string | undefined,
    prompt: string,
    options?: NikoflowLoopOptions,
  ) => boolean;
  cancelLoop: (sessionId: string) => boolean;
  getState: (sessionId?: string) => NikoflowState | null;
}

const MODE = "nikoflow";

/** Read Nikoflow state from disk (session-isolated). */
export function readNikoflowState(
  directory: string,
  sessionId?: string,
): NikoflowState | null {
  const state = readModeState<NikoflowState>(MODE, directory, sessionId);
  if (state && sessionId && state.session_id && state.session_id !== sessionId) {
    return null;
  }
  return state;
}

/** Write Nikoflow state to disk. */
export function writeNikoflowState(
  directory: string,
  state: NikoflowState,
  sessionId?: string,
): boolean {
  return writeModeState(
    MODE,
    state as unknown as Record<string, unknown>,
    directory,
    sessionId,
  );
}

/** Clear Nikoflow state. */
export function clearNikoflowState(
  directory: string,
  sessionId?: string,
): boolean {
  // Also drop the user-turn sidecar so a later flow can't read a stale stamp.
  const turn = userTurnPath(directory, sessionId);
  if (turn && existsSync(turn)) {
    try {
      unlinkSync(turn);
    } catch {
      /* best-effort */
    }
  }
  return clearModeStateFile(MODE, directory, sessionId);
}

/** Increment the Nikoflow iteration counter. */
export function incrementNikoflowIteration(
  directory: string,
  sessionId?: string,
): NikoflowState | null {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) {
    return null;
  }
  state.iteration += 1;
  state.last_checked_at = new Date().toISOString();
  return writeNikoflowState(directory, state, sessionId) ? state : null;
}

/**
 * Detect an explicit depth tier from the prompt.
 * Accepts `nikoflow:deep`, `--tier=standard`, `--depth deep`, `--deep`, etc.
 */
export function detectDepthFlag(prompt: string): NikoflowDepth | null {
  const colon = prompt.match(/nikoflow\s*:\s*(tactical|standard|deep)/i);
  if (colon) return colon[1].toLowerCase() as NikoflowDepth;
  const tier = prompt.match(/--(?:tier|depth)(?:=|\s+)(tactical|standard|deep)/i);
  if (tier) return tier[1].toLowerCase() as NikoflowDepth;
  if (/--deep\b/i.test(prompt)) return "deep";
  if (/--tactical\b/i.test(prompt)) return "tactical";
  if (/--standard\b/i.test(prompt)) return "standard";
  return null;
}

/** Strip nikoflow control flags from the task text. */
export function stripNikoflowFlags(prompt: string): string {
  return prompt
    .replace(/nikoflow\s*:\s*(tactical|standard|deep)/gi, "")
    .replace(/--(?:tier|depth)(?:=|\s+)(tactical|standard|deep)/gi, "")
    .replace(/--(?:deep|tactical|standard)\b/gi, "")
    .replace(/--(?:exec|executor|architect|arch|qa|reviewer|verifier|panel)(?:=|\s+)[^\s]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse per-role model overrides from the prompt. `--qa=X` sets both reviewer
 *  and verifier; `--panel=a+b` sets the grilling panel. Returns a partial to
 *  merge over the defaults. */
export function detectRoleFlags(prompt: string): Partial<NikoflowRoles> {
  const out: Partial<NikoflowRoles> = {};
  // Only accept recognized specs so a typo can't reach a Task `model=`.
  const val = (re: RegExp): string | undefined => {
    const m = prompt.match(re)?.[1]?.toLowerCase();
    return m && isValidModelSpec(m) ? m : undefined;
  };
  const exec = val(/--(?:exec|executor)(?:=|\s+)([^\s]+)/i);
  if (exec) out.executor = exec;
  const arch = val(/--(?:architect|arch)(?:=|\s+)([^\s]+)/i);
  if (arch) out.architect = arch;
  const qa = val(/--qa(?:=|\s+)([^\s]+)/i);
  if (qa) {
    out.reviewer = qa;
    out.verifier = qa;
  }
  const rev = val(/--reviewer(?:=|\s+)([^\s]+)/i);
  if (rev) out.reviewer = rev;
  const ver = val(/--verifier(?:=|\s+)([^\s]+)/i);
  if (ver) out.verifier = ver;
  const panelRaw = prompt.match(/--panel(?:=|\s+)([^\s]+)/i)?.[1]?.toLowerCase();
  if (panelRaw) {
    const panel = panelRaw.split("+").filter((m) => m && isValidModelSpec(m));
    if (panel.length > 0) out.panel = panel;
  }
  return out;
}

/** Merge role overrides over the defaults. */
export function resolveRoles(overrides?: Partial<NikoflowRoles>): NikoflowRoles {
  return { ...NIKOFLOW_DEFAULT_ROLES, ...(overrides ?? {}) };
}

/** Whether a model spec routes through a Codex-backed agent (GPT-5.5). */
export function isCodexRoleSpec(spec: string): boolean {
  return (NIKOFLOW_CODEX_SPECS as readonly string[]).includes(spec.toLowerCase());
}

/** Whether a model spec is a recognized native model or Codex spec. Unknown
 *  specs (typos like "sonet") are ignored so they can't reach a Task `model=`. */
export function isValidModelSpec(spec: string): boolean {
  const s = spec.toLowerCase();
  return (
    (NIKOFLOW_NATIVE_MODELS as readonly string[]).includes(s) ||
    (NIKOFLOW_CODEX_SPECS as readonly string[]).includes(s)
  );
}

/** Materialize the phase list for a depth tier. */
export function materializePhases(depth: NikoflowDepth): string[] {
  return [...NIKOFLOW_PHASES[depth]];
}

/**
 * The current phase name, or null when the depth is not yet chosen (still in
 * depth-selection / grilling) or when every phase has completed.
 */
export function getCurrentPhase(state: NikoflowState): string | null {
  if (!state.depth || state.phases.length === 0) return null;
  return state.phases[state.phase_index] ?? null;
}

/** Whether all phases have completed (phase_index ran off the end). */
export function isNikoflowComplete(state: NikoflowState): boolean {
  return (
    !!state.depth &&
    state.phases.length > 0 &&
    state.phase_index >= state.phases.length
  );
}

/**
 * Set the depth tier and materialize the phase list. Depth is immutable once
 * the flow has advanced past the first phase — tier changes mid-flow would
 * invalidate already-passed gates, so callers must cancel + restart instead.
 * Returns false if the change is rejected.
 */
export function setNikoflowDepth(
  directory: string,
  depth: NikoflowDepth,
  sessionId?: string,
): boolean {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) return false;

  // Immutable after the flow has moved past depth selection.
  if (state.depth && state.phase_index > 0) return false;

  state.depth = depth;
  state.phases = materializePhases(depth);
  state.phase_index = 0;
  state.pbt_enabled = depth === "deep";
  return writeNikoflowState(directory, state, sessionId);
}

/**
 * Advance to the next phase. Returns the new current phase, or null when the
 * flow has completed all phases (the caller should then clear state / cancel).
 * No-op guard: cannot advance before a depth is chosen.
 */
export function advanceNikoflowPhase(
  directory: string,
  sessionId?: string,
): { phase: string | null; complete: boolean } | null {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active || !state.depth || state.phases.length === 0) {
    return null;
  }

  // Idempotent past the end: a re-fired gate detector must not drift the index.
  if (state.phase_index >= state.phases.length) {
    return { phase: null, complete: true };
  }

  state.phase_index += 1;
  const complete = state.phase_index >= state.phases.length;
  if (!writeNikoflowState(directory, state, sessionId)) return null;

  return {
    phase: complete ? null : state.phases[state.phase_index],
    complete,
  };
}

/**
 * Ensure a correlation request_id exists for the given gate. Mints a fresh id
 * (and records the mint time) whenever the gate changed or no id is set, so a
 * confirmation tag left over from a previous gate can never satisfy a new one.
 * Returns the active request_id, or null if state is missing.
 */
export function mintGateRequest(
  directory: string,
  gate: string,
  sessionId?: string,
): string | null {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) return null;

  if (state.awaiting_gate === gate && state.request_id) {
    return state.request_id;
  }

  state.request_id = randomUUID();
  state.awaiting_gate = gate;
  state.gate_request_minted_at = new Date().toISOString();
  return writeNikoflowState(directory, state, sessionId) ? state.request_id : null;
}

/**
 * Force a fresh request_id + mint time for the current gate, even if the gate
 * is unchanged. Used to invalidate a confirmation tag the model emitted BEFORE
 * a real user turn: after rotation the stale tag no longer correlates, so the
 * model must re-emit the tag only after the user has actually replied.
 */
export function rotateGateRequest(
  directory: string,
  gate: string,
  sessionId?: string,
): string | null {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) return null;
  state.request_id = randomUUID();
  state.awaiting_gate = gate;
  state.gate_request_minted_at = new Date().toISOString();
  return writeNikoflowState(directory, state, sessionId) ? state.request_id : null;
}

/** Clear the current gate correlation (after a gate passes). */
export function clearGateRequest(
  directory: string,
  sessionId?: string,
): boolean {
  const state = readNikoflowState(directory, sessionId);
  if (!state) return false;
  delete state.request_id;
  delete state.awaiting_gate;
  delete state.gate_request_minted_at;
  return writeNikoflowState(directory, state, sessionId);
}

/** Increment the failed-verify-pass counter and return the new value. */
export function recordVerifyPass(
  directory: string,
  sessionId?: string,
): number {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) return 0;
  state.verify_pass = (state.verify_pass ?? 0) + 1;
  state.verify_no_verdict = 0; // a verdict was seen → reset the livelock guard
  writeNikoflowState(directory, state, sessionId);
  return state.verify_pass;
}

/** Count a verify Stop that produced NO parseable reviewer verdict. Returns the
 *  running count so the caller can escalate before an unbounded reviewer loop. */
export function bumpVerifyNoVerdict(directory: string, sessionId?: string): number {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) return 0;
  state.verify_no_verdict = (state.verify_no_verdict ?? 0) + 1;
  writeNikoflowState(directory, state, sessionId);
  return state.verify_no_verdict;
}

/** Reset the verify no-verdict counter (a verdict was seen). */
export function resetVerifyNoVerdict(directory: string, sessionId?: string): void {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active || !state.verify_no_verdict) return;
  state.verify_no_verdict = 0;
  writeNikoflowState(directory, state, sessionId);
}

/** Count an execute Stop that made no progress on `ticketId` (no reviewer verdict).
 *  Resets when the tracked ticket changes. Returns the running stall count. */
export function bumpExecuteStall(
  directory: string,
  ticketId: string,
  sessionId?: string,
): number {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) return 0;
  if (state.execute_stall_ticket !== ticketId) {
    state.execute_stall_ticket = ticketId;
    state.execute_stall = 1;
  } else {
    state.execute_stall = (state.execute_stall ?? 0) + 1;
  }
  writeNikoflowState(directory, state, sessionId);
  return state.execute_stall;
}

/** Reset the execute-stall counter (a ticket advanced). */
export function resetExecuteStall(directory: string, sessionId?: string): void {
  const state = readNikoflowState(directory, sessionId);
  if (!state || !state.active) return;
  if (state.execute_stall || state.execute_stall_ticket) {
    delete state.execute_stall;
    delete state.execute_stall_ticket;
    writeNikoflowState(directory, state, sessionId);
  }
}

const USER_TURN_KEY = "nikoflow-userturn";

function userTurnPath(directory: string, sessionId?: string): string | null {
  if (!sessionId) return null;
  return resolveSessionStatePath(USER_TURN_KEY, sessionId, directory);
}

/** ISO timestamp of the most recent real user turn, from the sidecar (or null). */
export function readNikoflowUserTurnAt(
  directory: string,
  sessionId?: string,
): string | null {
  const p = userTurnPath(directory, sessionId);
  if (!p || !existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, "utf-8")) as { at?: unknown };
    return typeof obj.at === "string" ? obj.at : null;
  } catch {
    return null;
  }
}

/**
 * Record a real UserPromptSubmit turn. Written to a DEDICATED sidecar file, not
 * the mode state, so the every-prompt stamp never read-modify-writes the shared
 * nikoflow-state.json — a RMW there races the Stop hook's request-id rotation and
 * could resurrect a rotated id, defeating anti-self-approval (Fable QA R2).
 */
export function recordNikoflowUserPrompt(
  directory: string,
  sessionId?: string,
): boolean {
  const p = userTurnPath(directory, sessionId);
  if (!p) {
    // No session scope → single-process, no cross-process race; fall back to state.
    const state = readNikoflowState(directory, sessionId);
    if (!state || !state.active) return false;
    state.last_user_prompt_at = new Date().toISOString();
    return writeNikoflowState(directory, state, sessionId);
  }
  try {
    atomicWriteJsonSync(p, { at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

/** Effective last-user-turn ms: sidecar preferred, state as fallback. */
function effectiveUserTurnAt(
  state: NikoflowState,
  directory?: string,
  sessionId?: string,
): number | null {
  const candidates: number[] = [];
  if (directory) {
    const side = readNikoflowUserTurnAt(directory, sessionId);
    if (side) {
      const t = new Date(side).getTime();
      if (Number.isFinite(t)) candidates.push(t);
    }
  }
  if (state.last_user_prompt_at) {
    const t = new Date(state.last_user_prompt_at).getTime();
    if (Number.isFinite(t)) candidates.push(t);
  }
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Whether a real user prompt arrived AFTER the current gate request was minted.
 * The load-bearing anti-self-approval check for human gates: the model cannot
 * satisfy a human gate without an actual user turn in between.
 */
export function userRepliedAfterMint(
  state: NikoflowState,
  directory?: string,
  sessionId?: string,
): boolean {
  if (!state.gate_request_minted_at) return false;
  const minted = new Date(state.gate_request_minted_at).getTime();
  const replied = effectiveUserTurnAt(state, directory, sessionId);
  if (!Number.isFinite(minted) || replied === null) return false;
  return replied > minted;
}

/** Whether a user turn happened within thresholdMs — a liveness signal so a flow
 *  parked at a human gate overnight isn't killed by the stale timer (Fable QA R4). */
export function isNikoflowUserTurnFresh(
  directory: string,
  sessionId: string | undefined,
  thresholdMs: number,
): boolean {
  const at = readNikoflowUserTurnAt(directory, sessionId);
  if (!at) return false;
  const t = new Date(at).getTime();
  return Number.isFinite(t) && Date.now() - t < thresholdMs;
}

/** Create a Nikoflow loop hook instance bound to a working directory. */
export function createNikoflowLoopHook(directory: string): NikoflowLoopHook {
  const startLoop = (
    sessionId: string | undefined,
    prompt: string,
    options?: NikoflowLoopOptions,
  ): boolean => {
    const now = new Date().toISOString();
    const depth = options?.depth ?? detectDepthFlag(prompt);
    const normalizedPrompt = stripNikoflowFlags(prompt);

    const state: NikoflowState = {
      active: true,
      iteration: 1,
      started_at: now,
      last_checked_at: now,
      prompt: normalizedPrompt,
      session_id: sessionId,
      project_path: directory,
      depth,
      phases: depth ? materializePhases(depth) : [],
      phase_index: 0,
      pbt_enabled: depth === "deep",
      roles: resolveRoles(detectRoleFlags(prompt)),
    };

    return writeNikoflowState(directory, state, sessionId);
  };

  const cancelLoop = (sessionId: string): boolean => {
    const state = readNikoflowState(directory, sessionId);
    if (!state || state.session_id !== sessionId) {
      return false;
    }
    return clearNikoflowState(directory, sessionId);
  };

  const getState = (sessionId?: string): NikoflowState | null => {
    return readNikoflowState(directory, sessionId);
  };

  return { startLoop, cancelLoop, getState };
}
