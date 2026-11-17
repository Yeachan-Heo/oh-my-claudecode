/**
 * Read-only status of one graph run, for `omc graph status <run_id>`.
 *
 * Reads only `<runs-root>/<run_id>/projection.json` and `journal.jsonl`. The
 * run state is derived, because the graph runtime writes no terminal record to
 * disk. The rule is the one the runtime and `omc graph gc` use (projectionOutcome in run-gc.ts):
 *   succeeded    the scheduler success predicate holds: a terminal verification activation completed with an
 *                evidence-bearing succeeded transition, every activation is completed and every cohort is consumed;
 *   failed       no activation is ready or running and the run did not succeed (the runtime ends such a run as failed,
 *                for example after a failed step or a denied approval);
 *   in_progress  an activation is ready or running, including a run interrupted by a signal (its last attempt was
 *                never committed).
 * Every activation counts, not only the latest one of each node. A node that never got an activation (for example the
 * step after a failed step) is not listed.
 * A file that is still being written (a partial last journal line), a journal with a gap in its seq numbers, and a
 * projection that lags the journal (a crash between the journal append and the snapshot save) read as "unreadable":
 * retry later, or rerun the run, which replays the journal.
 */

import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { RUN_ID_PATTERN } from "./run-dir.js";
import { projectionOutcome } from "./run-gc.js";

export const RUN_STATUS_EXIT_CODES = {
  succeeded: 0,
  failed: 1,
  in_progress: 3,
  missing: 2,
  usage: 2,
  unreadable: 4,
} as const;

const COMMAND_NAME = "omc graph status";
// Same open flags as `omc graph gc`: no link following, and no blocking on a FIFO.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export interface RunStatusOptions {
  readonly runId: string;
  /** Runs root directory; the CLI passes `.omc/graph-runs` when `--runs-root` is not given. */
  readonly runsRoot: string;
}

export interface RunStatusOutcome {
  /** Exit code of the command (see RUN_STATUS_EXIT_CODES). */
  readonly exitCode: number;
  /** One JSON object followed by a newline, for stdout. Empty for usage errors. */
  readonly stdout: string;
  /** Usage message for stderr; empty unless the arguments were refused. */
  readonly stderr: string;
}

interface Activation {
  readonly activation_id: string;
  readonly node_id: string;
  readonly status: string;
  readonly attempt_no: number;
  readonly completed_transition_id?: string;
}

interface Transition {
  readonly node_id?: string;
  readonly outcome: string;
  readonly output_summary?: string;
  readonly evidence_refs: readonly unknown[];
}

interface Projection {
  readonly activations: Record<string, Activation>;
  readonly cohorts: Record<string, { readonly consumed: boolean }>;
  readonly committed_transitions: Record<string, Transition | undefined>;
  readonly terminal_verification_activation_ids: readonly string[];
}

interface ProjectionEnvelope {
  readonly projection: Projection;
  readonly saved_at_seq: number;
}

class UnreadableError extends Error {}

function usage(message: string): RunStatusOutcome {
  return {
    exitCode: RUN_STATUS_EXIT_CODES.usage,
    stdout: "",
    stderr: `${COMMAND_NAME}: ${message}\nusage: omc graph status <run_id> [--runs-root DIR]\n`,
  };
}

// Reads one run file as text. Never follows a symbolic link, and refuses a FIFO or other
// non-regular file right after open, so it cannot block the command.
function readRunText(file: string): string {
  const name = basename(file);
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UnreadableError(
      `${name}: ${code === "ELOOP" || code === "ENOTDIR" ? "not a regular file" : (code ?? "unreadable")}`,
    );
  }
  try {
    if (!fstatSync(fd).isFile()) throw new UnreadableError(`${name}: not a regular file`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readProjectionEnvelope(file: string): ProjectionEnvelope {
  const text = readRunText(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UnreadableError(`projection.json: ${(error as Error).message}`);
  }
  const envelope = parsed as { projection?: Projection; saved_at_seq?: unknown } | null;
  const projection = envelope?.projection;
  const savedAtSeq = envelope?.saved_at_seq;
  if (!projection || typeof projection !== "object") {
    throw new UnreadableError("projection.json has no projection object");
  }
  if (
    !projection.activations ||
    !projection.cohorts ||
    !projection.committed_transitions ||
    !Array.isArray(projection.terminal_verification_activation_ids)
  ) {
    throw new UnreadableError(
      "projection.json lacks activations, cohorts, committed_transitions or terminal_verification_activation_ids",
    );
  }
  if (Object.keys(projection.activations).length === 0) {
    throw new UnreadableError("projection.json has no activations");
  }
  if (typeof savedAtSeq !== "number" || !Number.isInteger(savedAtSeq)) {
    throw new UnreadableError("projection.json has invalid saved_at_seq");
  }
  return { projection, saved_at_seq: savedAtSeq };
}



function readJournal(file: string): Transition[] {
  const lines = readRunText(file)
    .split("\n")
    .filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    let entry: { seq?: unknown; transition?: Transition } | null;
    try {
      entry = JSON.parse(line) as { seq?: unknown; transition?: Transition } | null;
    } catch (error) {
      throw new UnreadableError(`journal.jsonl line ${index + 1}: ${(error as Error).message}`);
    }
    if (!entry || !entry.transition) {
      throw new UnreadableError(`journal.jsonl line ${index + 1} has no transition`);
    }
    // The runtime numbers records 0, 1, 2, ... without gaps (as omc graph gc checks), so the last seq is the count - 1.
    if (entry.seq !== index) {
      throw new UnreadableError(`journal.jsonl line ${index + 1} has seq ${String(entry.seq)}, expected ${index}`);
    }
    return entry.transition;
  });
}

function nodeStateOf(
  activation: Activation,
  committed: Record<string, Transition | undefined>,
): string {
  if (activation.status === "completed") {
    const transition = activation.completed_transition_id
      ? committed[activation.completed_transition_id]
      : undefined;
    if (transition && transition.outcome === "succeeded") return "succeeded";
    if (transition && transition.outcome === "failed") return "failed";
    return "completed";
  }
  return activation.status;
}

function summarize(runId: string, runDir: string, runsRoot: string): Record<string, unknown> {
  const envelope = readProjectionEnvelope(join(runDir, "projection.json"));
  const projection = envelope.projection;
  const journalFile = join(runDir, "journal.jsonl");
  const committed = projection.committed_transitions;
  const activations = projection.activations;
  let transitions: Transition[] = [];
  if (existsSync(journalFile)) {
    transitions = readJournal(journalFile);
  } else if (Object.keys(committed).length > 0) {
    throw new UnreadableError(
      "journal.jsonl is missing although the projection has committed transitions",
    );
  }

  // A snapshot that lags the journal (the crash window between journal.append and store.save in the runner) shows
  // older activation states than the committed history; refuse it rather than report it. A journal that is shorter
  // than the snapshot (for example emptied) is not refused: the snapshot still holds every committed transition.
  const journalSeq = transitions.length - 1;
  if (envelope.saved_at_seq < journalSeq) {
    throw new UnreadableError(
      `projection is stale (saved_at_seq ${envelope.saved_at_seq} < journal seq ${journalSeq})`,
    );
  }

  const lastActivationByNode = new Map<string, Activation>();
  for (const activation of Object.values(activations)) {
    lastActivationByNode.set(activation.node_id, activation);
  }

  const nodes = [...lastActivationByNode.entries()].map(([nodeId, activation]) => {
    const state = nodeStateOf(activation, committed);
    const failures = transitions.filter(
      (t) => t.node_id === nodeId && (t.outcome === "failed" || t.outcome === "denied"),
    );
    const lastFailure = failures.length > 0 ? failures[failures.length - 1] : null;
    return {
      id: nodeId,
      activation_id: activation.activation_id,
      state,
      attempts: activation.attempt_no,
      last_error: state === "succeeded" || lastFailure === null ? null : lastFailure.output_summary,
    };
  });

  const outcome = projectionOutcome(projection as unknown as Record<string, any>);
  const state: keyof typeof RUN_STATUS_EXIT_CODES =
    outcome === "succeeded" ? "succeeded" : outcome === "failed" ? "failed" : "in_progress";

  return {
    run_id: runId,
    runs_root: runsRoot,
    state,
    exit_code: RUN_STATUS_EXIT_CODES[state],
    committed_transitions: transitions.length,
    nodes,
  };
}

// True only for a symbolic link that exists; a missing path is not a link.
function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Derives the status of one run. Read-only: nothing on disk is created or changed. */
export function readRunStatus(options: RunStatusOptions): RunStatusOutcome {
  if (!RUN_ID_PATTERN.test(options.runId)) {
    return usage(`invalid run_id ${options.runId}`);
  }
  const runsRoot = options.runsRoot;
  const runDir = join(runsRoot, options.runId);

  try {
    // A symlinked run directory is refused before anything is read through it. Run files are opened
    // without following links (see readRunText).
    if (isSymbolicLink(runDir)) throw new UnreadableError("run directory is a symbolic link");
    if (!existsSync(join(runDir, "projection.json"))) {
      const missing = { run_id: options.runId, runs_root: runsRoot, state: "missing", exit_code: RUN_STATUS_EXIT_CODES.missing };
      return {
        exitCode: RUN_STATUS_EXIT_CODES.missing,
        stdout: `${JSON.stringify(missing)}\n`,
        stderr: "",
      };
    }

    const status = summarize(options.runId, runDir, runsRoot);
    return { exitCode: status.exit_code as number, stdout: `${JSON.stringify(status)}\n`, stderr: "" };
  } catch (error) {
    // Any read or parse failure is reported as state "unreadable", never as a crash or as "failed".
    const reason =
      error instanceof UnreadableError
        ? error.message
        : `${(error as NodeJS.ErrnoException).code || (error as Error).name}: ${(error as Error).message}`;
    const unreadable = {
      run_id: options.runId,
      runs_root: runsRoot,
      state: "unreadable",
      exit_code: RUN_STATUS_EXIT_CODES.unreadable,
      error: reason,
    };
    return {
      exitCode: RUN_STATUS_EXIT_CODES.unreadable,
      stdout: `${JSON.stringify(unreadable)}\n`,
      stderr: "",
    };
  }
}
