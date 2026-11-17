/**
 * Read-only status of one graph run, for `omc graph status <run_id>`.
 *
 * Reads only `<runs-root>/<run_id>/descriptor.json`, `projection.json` and `journal.jsonl`. The
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
 *
 * The files must belong to the requested run. The snapshot is validated as FileProjectionStore validates it and is
 * bound to the run's descriptor.json (descriptor hash, run id, revision; the projection inside names the same run
 * and descriptor), every journal record carries that descriptor's hash and no writer epoch above the snapshot's.
 * A projection or journal copied or restored from another run reads as "unreadable", never as the state of this one.
 *
 * The three files are read through one open handle on the run directory (the runtime's own directory-relative
 * operations, on Linux and on macOS with the native module), so a directory that is swapped for a link or for another
 * directory after the check cannot redirect the reads, and the name must still be the same directory (device and
 * inode) after the reads. Where the runtime has no such primitive the files are read by path, with the same check of
 * the directory before and after.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containedFsPlatformSupported } from "./contained-fd.js";
import { RUN_ID_PATTERN } from "./run-dir.js";
import {
  checkSnapshotEnvelope,
  parseJournalLines,
  parseRunDescriptor,
  projectionBelongsToRun,
  projectionOutcome,
  RunBindingError,
} from "./run-gc.js";
import { withContainedOperations } from "./safe-fs.js";

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
  /** Test-only hooks that run inside the window between the check of the run directory and its use. */
  readonly interlock?: {
    /** After the run directory was checked and before it is opened. */
    readonly afterDirectoryCheck?: () => void;
    /** After the files were read and before the directory is checked again. */
    readonly afterRead?: () => void;
  };
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

class UnreadableError extends Error {}

function usage(message: string): RunStatusOutcome {
  return {
    exitCode: RUN_STATUS_EXIT_CODES.usage,
    stdout: "",
    stderr: `${COMMAND_NAME}: ${message}\nusage: omc graph status <run_id> [--runs-root DIR]\n`,
  };
}

type OpenRunFile = (name: string) => number;

// Reads one run file as text through `open`, which never follows a symbolic link. Returns null when the file does not
// exist. A FIFO or other non-regular file is refused right after open, so it cannot block the command.
function readRunText(open: OpenRunFile, name: string): string | null {
  let fd: number;
  try {
    fd = open(name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
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

interface RunFiles {
  readonly descriptor: string | null;
  readonly projection: string | null;
  readonly journal: string | null;
}

// Reads the files of one run. Returns null when there is no run directory.
function readRunFiles(runDir: string, interlock: RunStatusOptions["interlock"]): RunFiles | null {
  let before;
  try {
    before = lstatSync(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw new UnreadableError("run directory is a symbolic link");
  if (!before.isDirectory()) throw new UnreadableError("run directory is not a directory");
  interlock?.afterDirectoryCheck?.();

  const flags = fsConstants.O_RDONLY | NONBLOCK;
  const readAll = (open: OpenRunFile): RunFiles => ({
    descriptor: readRunText(open, "descriptor.json"),
    projection: readRunText(open, "projection.json"),
    journal: readRunText(open, "journal.jsonl"),
  });
  let files: RunFiles;
  if (containedFsPlatformSupported(process.platform)) {
    try {
      // The directory is opened without following a link and must be the one that was checked (device and inode).
      files = withContainedOperations({ path: runDir, device: before.dev, inode: before.ino }, (operations) =>
        readAll((name) => operations.open(name, flags)),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new UnreadableError("run directory was replaced by a link or a file while it was read");
      }
      if ((error as Error).message === "run directory identity changed") {
        throw new UnreadableError("run directory was replaced while it was read");
      }
      throw error;
    }
  } else {
    files = readAll((name) => openSync(join(runDir, name), flags | NOFOLLOW));
  }
  interlock?.afterRead?.();
  const after = lstatSync(runDir);
  if (after.dev !== before.dev || after.ino !== before.ino) {
    throw new UnreadableError("run directory was replaced while it was read");
  }
  return files;
}

function parseJson(name: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UnreadableError(`${name}: ${(error as Error).message}`);
  }
}

// A file that does not belong to the run is unreadable, with the reason the shared check gives.
function bound<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof RunBindingError) throw new UnreadableError(error.message);
    throw error;
  }
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

function summarize(runId: string, files: RunFiles, runsRoot: string): Record<string, unknown> {
  if (files.descriptor === null) throw new UnreadableError("descriptor.json is missing");
  const descriptor = bound(() => parseRunDescriptor(parseJson("descriptor.json", files.descriptor as string), runId));
  const envelope = bound(() =>
    checkSnapshotEnvelope(parseJson("projection.json", files.projection as string), descriptor, runId),
  );
  const projection = envelope.projection as unknown as Projection;
  if (!projectionBelongsToRun(projection as unknown as Record<string, any>, descriptor.descriptorHash, runId)) {
    throw new UnreadableError("projection.json holds the projection of another run or descriptor");
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
  const committed = projection.committed_transitions;
  const activations = projection.activations;
  let transitions: Transition[] = [];
  let journalEpoch = 0;
  if (files.journal !== null) {
    const lines = files.journal.split("\n").filter((line) => line.trim() !== "");
    // Same checks as the runtime's replay: envelope, seq 0, 1, 2, ... without a gap, this run's descriptor on every
    // record, epochs that never decrease (as omc graph gc checks), so the last seq is the count - 1.
    const records = bound(() => parseJournalLines(lines, descriptor.descriptorHash));
    transitions = records.map((record) => record.transition as Transition);
    journalEpoch = records.length > 0 ? (records[records.length - 1].epoch as number) : 0;
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
  // The snapshot is saved by the writer that appended its last record, so no record may carry a later epoch.
  if (journalEpoch > envelope.epoch) {
    throw new UnreadableError(`journal.jsonl has epoch ${journalEpoch}, above the epoch ${envelope.epoch} of projection.json`);
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

/** Derives the status of one run. Read-only: nothing on disk is created or changed. */
export function readRunStatus(options: RunStatusOptions): RunStatusOutcome {
  if (!RUN_ID_PATTERN.test(options.runId)) {
    return usage(`invalid run_id ${options.runId}`);
  }
  const runsRoot = options.runsRoot;
  const runDir = join(runsRoot, options.runId);

  try {
    // A symlinked run directory is refused before anything is read through it, and the files are read through
    // one open handle on the directory (see readRunFiles).
    const files = readRunFiles(runDir, options.interlock);
    if (files === null || files.projection === null) {
      const missing = { run_id: options.runId, runs_root: runsRoot, state: "missing", exit_code: RUN_STATUS_EXIT_CODES.missing };
      return {
        exitCode: RUN_STATUS_EXIT_CODES.missing,
        stdout: `${JSON.stringify(missing)}\n`,
        stderr: "",
      };
    }

    const status = summarize(options.runId, files, runsRoot);
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
