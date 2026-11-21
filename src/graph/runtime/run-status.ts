/**
 * Read-only status of one graph run, for `omc graph status <run_id>`.
 *
 * Reads only `<runs-root>/<run_id>/descriptor.json`, `projection.json` and `journal.jsonl`. The run state is derived,
 * because the graph runtime writes no terminal record to disk, and it is derived the way the runtime derives it: the
 * journal is replayed (classifyRunFiles in run-state.ts, the same function `omc graph gc` uses, built on the
 * runtime's replay fold) and `projection.json` is a status cache that is never trusted for the verdict. The states:
 *   succeeded    the scheduler success predicate holds after the replay;
 *   failed       no activation can be started, resolved or approved and the run did not succeed (the runtime ends
 *                such a run as failed, for example after a failed step or a denied approval);
 *   in_progress  an activation is ready, including a run interrupted by a signal (its last attempt was never
 *                committed, so it is ready again);
 *   missing      there is no run directory (exit 2);
 *   unreadable   the directory exists but its files are not a run the runtime could resume (exit 4): no descriptor, a
 *                descriptor of another run, a partial last journal line (a file still being written), a journal with
 *                a gap, another run's records or a record that fails the replay, or a descriptor with neither a
 *                committed record nor the initial snapshot. A run whose snapshot is lost, stale or restored is
 *                reported from its journal.
 * Every activation counts, not only the latest one of each node. A node that never got an activation (for example the
 * step after a failed step) is not listed.
 *
 * The three files are read through one open handle on the run directory (the runtime's own directory-relative
 * operations, on Linux and on macOS with the native module), so a directory that is swapped for a link or for another
 * directory after the check cannot redirect the reads, and the name must still be the same directory (device and
 * inode) after the reads. Where the runtime has no such primitive the files are read by path, with the same check of
 * the directory before and after.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containedFsPlatformSupported, directoryOperationsIfSupported, type DirectoryOperations } from "./contained-fd.js";
import { RUN_ID_PATTERN } from "./run-dir.js";
import { classifyRunFiles } from "./run-state.js";

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
  /** Test-only hooks: they run inside the window between the check of the run directory and its use, or replace the operations of the platform. */
  readonly interlock?: {
    /** After the run directory was checked and before it is opened. */
    readonly afterDirectoryCheck?: () => void;
    /** After the files were read and before the directory is checked again. */
    readonly afterRead?: () => void;
    /** The directory is open and is the one that was checked; no file is read yet. */
    readonly afterOpen?: () => void;
    /** Replaces the directory-relative operations of the platform; null stands for a platform that has none. */
    readonly operationsFor?: (fd: number) => DirectoryOperations | null;
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
    // A missing run, or a runs root that is not a directory, has no such run.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
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
  const byName: OpenRunFile = (name) => openSync(join(runDir, name), flags | NOFOLLOW);
  let files: RunFiles;
  if (interlock?.operationsFor === undefined && !containedFsPlatformSupported(process.platform)) {
    // A platform that has no directory-relative operations (Windows) cannot open a directory as a file either: the files
    // are read by name, with the check of the directory before (above) and after (below). A name swapped and swapped back
    // in between is not seen there, and the report is read-only.
    files = readAll(byName);
  } else {
    // The directory is opened without following a link and must be the one that was checked (device and inode).
    let fd: number;
    try {
      fd = openSync(runDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new UnreadableError("run directory was replaced by a link or a file while it was read");
      }
      throw error;
    }
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new UnreadableError("run directory was replaced while it was read");
      }
      interlock?.afterOpen?.();
      // Every platform that has directory-relative operations (Linux, and macOS with the native module) reads relative
      // to the open directory, so a name swapped and swapped back during the reads changes nothing. Where the injected
      // operations are none, the files are read by name as above.
      const operations = (interlock?.operationsFor ?? directoryOperationsIfSupported)(fd);
      files = readAll(operations === null ? byName : (name) => operations.open(name, flags));
    } finally {
      closeSync(fd);
    }
  }
  interlock?.afterRead?.();
  const after = lstatSync(runDir);
  if (after.dev !== before.dev || after.ino !== before.ino) {
    throw new UnreadableError("run directory was replaced while it was read");
  }
  return files;
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
  const verdict = classifyRunFiles(runId, files);
  if (verdict.state === "unreadable") throw new UnreadableError(verdict.detail);
  const committed = verdict.projection.committed_transitions as unknown as Record<string, Transition | undefined>;
  const transitions = verdict.records.map((record) => record.transition as unknown as Transition);

  const lastActivationByNode = new Map<string, Activation>();
  for (const activation of Object.values(verdict.projection.activations) as unknown as Activation[]) {
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

  return {
    run_id: runId,
    runs_root: runsRoot,
    state: verdict.state,
    exit_code: RUN_STATUS_EXIT_CODES[verdict.state],
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
    if (files === null) {
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
