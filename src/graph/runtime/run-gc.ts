/**
 * Retention and torn-journal repair for graph run directories, for `omc graph gc`.
 *
 * Removes old run directories under the graph runs root (default `.omc/graph-runs`,
 * the runs root of `omc graph run`). On request it also moves a torn last journal
 * line aside. The command is offline housekeeping: it changes nothing in the
 * runtime and is not wired into any hook. Run it by hand or from a schedule.
 *
 * Switch: nothing is deleted or repaired unless OMC_GRAPH_GC is exactly "1".
 * Without it the command reports WOULD-DELETE and WOULD-REPAIR and writes nothing.
 * A repair also needs --repair-torn-wal or OMC_GRAPH_REPAIR_TORN_WAL="1".
 *
 * Configuration, highest precedence first:
 *   runs root        --runs-root <dir>            | OMC_GRAPH_RUNS_ROOT            | .omc/graph-runs (relative to cwd)
 *   retention days   --retention-days <N>         | OMC_GRAPH_RETENTION_DAYS       | 7 (positive integer only)
 *   repair torn WAL  --repair-torn-wal            | OMC_GRAPH_REPAIR_TORN_WAL="1"  | off
 *
 * Run state, derived from the files on disk (the runtime stores no status field). It is derived the way the runtime
 * derives it, by the function `omc graph status` uses (classifyRunFiles in run-state.ts): the journal is replayed with
 * the runtime's replay fold (descriptor binding, epochs, envelope and request fingerprints, scheduler transitions) and
 * projection.json is only a status cache, never trusted for the verdict. Under ownership the replay is bounded by the
 * epoch the lock gave, which is the bound a resume applies.
 *   final-succeeded      the scheduler success predicate holds after the replay
 *   final-failed         no activation can run after the replay, and the run did not succeed
 *   resumable-approval   a human-approval activation is ready
 *   resumable-ready      an activation is ready to start (an attempt that was running when the process stopped was
 *                        never committed, so it is ready again after the replay)
 *   unknown:<reason>     anything else (no descriptor, a descriptor of another run, a journal that is corrupt or fails
 *                        the replay, a descriptor with neither a record nor the initial snapshot); the run is kept
 * Only the two final states can be deleted, and only after the retention window. The runtime has no separate
 * "cancelled" state: an aborted run keeps its ready activations and stays resumable. Any doubt keeps the run.
 *
 * Safety rules:
 *   - The runs root must be named `.omc/graph-runs`. A symbolic link at the runs root is refused.
 *   - Only real directories whose names match the run id pattern are candidates.
 *   - A run is kept when it is the --current run; when its owner.lock names a live process or
 *     cannot be read (fail closed); when its journal ends in a torn line; when a torn copy from an
 *     earlier repair is still present; when it is fresh (an entry below it changed inside the
 *     retention window); or when its state is not final. An owner.lock whose pid is dead does not
 *     protect a run.
 *   - A torn last journal line is copied to `journal.jsonl.torn-<stamp>` before the journal is
 *     truncated. This command never deletes such a copy: a run that holds one is kept.
 *   - Removal takes ownership of the run first, through the same single-writer fence the runtime uses: a run that is
 *     owned, or whose ownership cannot be taken, is not removed. The scan records the identity (device and inode) of
 *     every run directory. Removal opens the directory without following a link and refuses it when it is not the
 *     scanned one, so a run replaced by a new run with the same id after the scan is never deleted on the verdict of
 *     the old one. Under the lock it decides the run again by the same rules as the scan (a resume that finished
 *     after the scan makes the run fresh again), then moves the run directory to
 *     `.deleted-<run id>-<time>-<random>` under the runs root (an atomic rename, so no process can resume the run
 *     from then on) and deletes the moved directory. A directory left behind by an interrupted removal is finished by
 *     the next pass, unless the lock inside it still names a live process.
 *   - Under ownership every file of the run is reached through the open run directory, whose identity is the scanned
 *     one (withRunDirectory): the decision reads, the journal and torn copy of a repair, and the directory sync. The
 *     name of the run is checked again before the copy, before the truncation and after the decision reads; a name
 *     that was swapped refuses the step. A directory can only be renamed by name, so the name is checked right before
 *     the move and the moved directory right after it, and a directory that is not the scanned one is put back.
 *   - Removal never follows a symbolic link: a link is unlinked, its target is left alone. On Linux every directory
 *     is opened without following links and its entries are removed relative to that open directory, so a
 *     directory swapped for a link while the tree is walked cannot redirect the removal. macOS (with the native
 *     contained-fs module) walks the moved directory by path with lstat. Where the fence cannot run (Windows, macOS
 *     without the module) ownership cannot be taken, and removal and repair fail closed: the run stays.
 *   - An invalid retention value stops the command before anything is touched.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { directoryOperations, type DirectoryOperations } from "./contained-fd.js";
import { FileOwnershipFence } from "./fence.js";
import { RUN_ID_PATTERN } from "./run-dir.js";
import { classifyRunFiles } from "./run-state.js";

export const GC_SWITCH_ENV = "OMC_GRAPH_GC";
export const GC_RETENTION_ENV = "OMC_GRAPH_RETENTION_DAYS";
export const GC_RUNS_ROOT_ENV = "OMC_GRAPH_RUNS_ROOT";
export const GC_REPAIR_ENV = "OMC_GRAPH_REPAIR_TORN_WAL";
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_GC_RUNS_ROOT = join(".omc", "graph-runs");

const LOCK_FILE_NAME = "owner.lock";
const DESCRIPTOR_FILE_NAME = "descriptor.json";
const SNAPSHOT_FILE_NAME = "projection.json";
const JOURNAL_FILE_NAME = "journal.jsonl";
const TORN_COPY_PREFIX = `${JOURNAL_FILE_NAME}.torn-`;
const QUARANTINE_PREFIX = ".deleted-";
const MAX_LOCK_BYTES = 4096;
const MAX_RETENTION_DAYS = 36500;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const COMMAND_NAME = "omc graph gc";

// Loosely typed JSON read from run files; the checks below validate the parts that are used.
type Json = Record<string, any>;

export class ConfigError extends Error {}

// Raised while reading one run. Its message is the reason recorded for that run.
class StateError extends Error {}

export interface LeaseState {
  readonly held: boolean;
  readonly reason: string;
}

// Device and inode of a directory, as recorded by the scan.
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

// What a removal needs from the scan to re-check a run under ownership: the scanned directory, the retention cutoff and
// the highest writer epoch the run had seen. Taking the lock gives the next epoch, so a higher one means that another
// process held the lock after the scan, even one that changed nothing.
export interface ScannedRun {
  readonly identity: FileIdentity;
  readonly cutoffMs: number;
  readonly epochFloor: number;
  /** Test-only interlocks: once the lock is held, and once the directory is open, each before the run is decided again. */
  readonly afterOwnership?: () => void;
  readonly afterHandle?: () => void;
  /** Test-only interlock: the decision reads under the lock are done; the name is not checked yet. */
  readonly afterReads?: () => void;
  /** Test-only interlock: after the name was checked for the last time, right before the directory is moved. */
  readonly beforeMove?: () => void;
}

interface RunEntry {
  id: string;
  decision: "keep" | "delete";
  reason: string;
  state: string | null;
  bytes: number;
  newestMs: number | null;
  identity: FileIdentity | null;
  epochFloor?: number;
  torn: boolean;
  action?: string;
  copy?: string;
  error?: string;
}

export interface GcScan {
  root: string;
  realRoot: string | null;
  retentionDays: number;
  cutoffMs: number;
  runs: RunEntry[];
  skipped: { id: string; reason: string }[];
}

export interface GcResult {
  root: string;
  retention_days: number;
  cutoff_iso: string;
  switch: boolean;
  repair_torn_wal: boolean;
  runs: {
    id: string;
    action: string | undefined;
    reason: string;
    state: string | null;
    bytes: number;
    newest_iso: string | null;
    copy?: string;
    error?: string;
  }[];
  skipped: { id: string; reason: string }[];
  summary: {
    runs: number;
    candidates: number;
    deleted: number;
    failed: number;
    bytes_candidates: number;
    bytes_deleted: number;
    repaired: number;
    repair_failed: number;
  };
}

export interface GcRunOptions {
  runsRoot: string;
  retentionDays: number;
  currentRunId?: string | null;
  enabled?: boolean;
  repairTornWal?: boolean;
  nowMs?: number;
  remove?: (realRoot: string, id: string, scanned?: ScannedRun) => void;
}

export function isSwitchOn(value: string | undefined): boolean {
  return value === "1";
}

export function parseRetentionDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_DAYS;
  const text = String(value);
  if (!/^[1-9][0-9]{0,4}$/.test(text) || Number(text) > MAX_RETENTION_DAYS) {
    throw new ConfigError(
      `retention days must be a positive integer up to ${MAX_RETENTION_DAYS}, got ${JSON.stringify(text)}`,
    );
  }
  return Number(text);
}

export function resolveRunsRoot(runsRoot: string): string {
  const absolute = resolve(runsRoot);
  if (basename(absolute) !== "graph-runs" || basename(dirname(absolute)) !== ".omc") {
    throw new ConfigError(`runs root must be a directory named .omc/graph-runs, got ${absolute}`);
  }
  return absolute;
}

// Returns the real path of the runs root, or null when it does not exist.
// Never creates the root.
function requireRealRunsRoot(absolute: string): string | null {
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new ConfigError(`runs root must not be a symbolic link: ${absolute}`);
  if (!stat.isDirectory()) throw new ConfigError(`runs root is not a directory: ${absolute}`);
  // A parent component may be a symbolic link, so the name is checked again on the resolved path.
  const real = realpathSync(absolute);
  if (basename(real) !== "graph-runs" || basename(dirname(real)) !== ".omc") {
    throw new ConfigError(`runs root must resolve to a directory named .omc/graph-runs, got ${real}`);
  }
  return real;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 is an existence check; nothing is sent
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Lease state of one run, read from owner.lock (JSON with pid, epoch, timestamp).
export function leaseOf(runDir: string): LeaseState {
  const lockPath = join(runDir, LOCK_FILE_NAME);
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { held: false, reason: "no-lock" };
    return { held: true, reason: "lock-unreadable" };
  }
  if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return { held: true, reason: "lock-not-a-small-file" };
  let pid: unknown;
  try {
    // Opened without following a link and refused when not a regular file, even if the entry was swapped after the lstat.
    const bytes = readRunFile(runDir, LOCK_FILE_NAME);
    if (bytes.length > MAX_LOCK_BYTES) return { held: true, reason: "lock-not-a-small-file" };
    pid = (JSON.parse(bytes.toString("utf8")) as Json).pid;
  } catch {
    return { held: true, reason: "lock-unparseable" };
  }
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return { held: true, reason: "lock-bad-pid" };
  if (isProcessAlive(pid as number)) return { held: true, reason: "lock-live-pid" };
  return { held: false, reason: "lock-stale-pid" };
}

// Names the fence creates and rewrites in a run directory while it holds the lock.
function isFenceEntry(name: string): boolean {
  return name === LOCK_FILE_NAME || name === "owner.epoch" || name.startsWith(`${LOCK_FILE_NAME}.tomb.`);
}

// The highest writer epoch a run has seen, from the epoch sidecar and from the lock; 0 when it has neither.
function epochFloorOf(runDir: string): number {
  let floor = 0;
  for (const name of ["owner.epoch", LOCK_FILE_NAME]) {
    try {
      const text = readRunFile(runDir, name).toString("utf8");
      const value = name === LOCK_FILE_NAME ? (JSON.parse(text) as Json).epoch : Number(text);
      if (Number.isSafeInteger(value) && value > floor) floor = value;
    } catch {
      // Missing or unreadable: this file gives no floor. The fence refuses a corrupt sidecar when it takes the lock.
    }
  }
  return floor;
}

// Identity, newest modification time and total file size of a run directory. The directory must be a plain directory.
// Every entry is read with lstat, so symbolic links are never followed. Under ownership (`ownedByFence`) the fence's
// own entries and the time of the directory itself are left out: taking the lock rewrote them just now and say nothing
// about when the run last changed.
function measureRun(
  runDir: string,
  ownedByFence = false,
  anchored = false,
): { newestMs: number; bytes: number; identity: FileIdentity } {
  // An anchored path (/proc/self/fd/<fd>) is a link to the open directory, so it is read with stat, not lstat.
  const top = anchored ? statSync(runDir) : lstatSync(runDir);
  if (!top.isDirectory()) throw new Error("run is not a plain directory");
  let newestMs = ownedByFence ? 0 : top.mtimeMs;
  let bytes = 0;
  const visit = (dir: string, isTop: boolean): void => {
    for (const name of readdirSync(dir)) {
      if (ownedByFence && isTop && isFenceEntry(name)) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      newestMs = Math.max(newestMs, stat.mtimeMs);
      if (stat.isFile()) bytes += stat.size;
      if (stat.isDirectory()) visit(path, false);
    }
  };
  visit(runDir, true);
  return { newestMs, bytes, identity: { dev: top.dev, ino: top.ino } };
}

// Reads one regular file below a run directory. Never follows a symbolic link, and a FIFO or other
// non-regular file is refused right after open (O_NONBLOCK), so it cannot block the command.
function readRunFile(runDir: string, name: string): Buffer {
  let fd: number;
  try {
    fd = openSync(join(runDir, name), fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new StateError(`${name}-missing`);
    if (code === "ELOOP" || code === "ENOTDIR") throw new StateError(`${name}-not-a-regular-file`);
    throw new StateError(`${name}-unreadable`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new StateError(`${name}-not-a-regular-file`);
    return readFileSync(fd);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError(`${name}-unreadable`);
  } finally {
    closeSync(fd);
  }
}

// Splits journal bytes into complete lines and a torn tail (the bytes after the last newline).
export function splitTornTail(bytes: Buffer): { complete: Buffer; tail: Buffer } {
  const cut = bytes.lastIndexOf(0x0a) + 1;
  return { complete: bytes.subarray(0, cut), tail: bytes.subarray(cut) };
}

// Reads one file of a run as text; null when it does not exist.
function readRunText(runDir: string, name: string): string | null {
  try {
    return readRunFile(runDir, name).toString("utf8");
  } catch (error) {
    if (error instanceof StateError && error.message === `${name}-missing`) return null;
    throw error;
  }
}

// Derives the state of one run from its files by the runtime's own replay (classifyRunFiles, the same function
// `omc graph status` uses): the journal is folded the way a resume folds it and the snapshot is never trusted. The
// states a run can have: final-succeeded and final-failed (the only ones that can be deleted), resumable-ready and
// resumable-approval (something is ready to run or to approve), and unknown:<reason> for anything else, which is kept.
// `epochCeiling` is the epoch the caller holds on the run, when it holds one (the runtime's bound on resume).
export function classifyRun(runDir: string, runId: string, epochCeiling?: number): { state: string; reason: string } {
  try {
    const files = {
      descriptor: readRunText(runDir, DESCRIPTOR_FILE_NAME),
      journal: readRunText(runDir, JOURNAL_FILE_NAME),
      projection: readRunText(runDir, SNAPSHOT_FILE_NAME),
    };
    const verdict = classifyRunFiles(runId, files, epochCeiling);
    if (verdict.state === "unreadable") return { state: "unknown", reason: `unknown:${verdict.reason}` };
    if (verdict.state === "succeeded") return { state: "final-succeeded", reason: "final-succeeded" };
    if (verdict.state === "failed") return { state: "final-failed", reason: "final-failed" };
    const state = verdict.approvalPending ? "resumable-approval" : "resumable-ready";
    return { state, reason: state };
  } catch (error) {
    if (error instanceof StateError) return { state: "unknown", reason: `unknown:${error.message}` };
    return { state: "unknown", reason: "unknown:unexpected-error" };
  }
}

// True when the journal's last line is torn. A missing or unreadable journal is not torn.
function hasTornTail(runDir: string): boolean {
  try {
    return splitTornTail(readRunFile(runDir, JOURNAL_FILE_NAME)).tail.length > 0;
  } catch {
    return false;
  }
}

function hasTornCopy(runDir: string): boolean {
  return readdirSync(runDir).some((name) => name.startsWith(TORN_COPY_PREFIX));
}

interface Verdict {
  decision: "keep" | "delete";
  reason: string;
  state: string | null;
  torn: boolean;
}

// The rules that decide a run whose lease is known to be free, in order: a torn journal, a torn copy of an earlier
// repair, a change inside the retention window, then the state. The scan and the re-check under ownership both use it.
function judgeRun(runDir: string, id: string, newestMs: number, cutoffMs: number, epochCeiling?: number): Verdict {
  if (hasTornTail(runDir)) return { decision: "keep", reason: "torn-wal", state: null, torn: true };
  if (hasTornCopy(runDir)) return { decision: "keep", reason: "torn-copy-kept", state: null, torn: false };
  if (newestMs >= cutoffMs) return { decision: "keep", reason: "fresh", state: null, torn: false };
  const verdict = classifyRun(runDir, id, epochCeiling);
  if (verdict.state === "final-succeeded" || verdict.state === "final-failed") {
    return { decision: "delete", reason: "expired", state: verdict.state, torn: false };
  }
  return { decision: "keep", reason: verdict.reason, state: verdict.state, torn: false };
}

// Decides what happens to each run. Modifies nothing.
export function scanRuns({
  runsRoot,
  retentionDays,
  currentRunId = null,
  nowMs = Date.now(),
}: {
  runsRoot: string;
  retentionDays: number;
  currentRunId?: string | null;
  nowMs?: number;
}): GcScan {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
    throw new ConfigError(`retention days must be a positive integer, got ${String(retentionDays)}`);
  }
  if (currentRunId !== null && !RUN_ID_PATTERN.test(currentRunId)) {
    throw new ConfigError(`current run id is not a valid run id: ${JSON.stringify(currentRunId)}`);
  }
  const root = resolveRunsRoot(runsRoot);
  const realRoot = requireRealRunsRoot(root);
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const scan: GcScan = { root, realRoot, retentionDays, cutoffMs, runs: [], skipped: [] };
  if (realRoot === null) return scan;

  for (const entry of readdirSync(realRoot, { withFileTypes: true })) {
    const id = entry.name;
    // A directory left behind by a removal that was interrupted after the move (see quarantineRun). It cannot be a
    // run: a run id never starts with a dot. It is finished unless the lock inside it names a live process (another
    // pass may still be deleting it).
    if (id.startsWith(QUARANTINE_PREFIX)) {
      if (entry.isSymbolicLink()) {
        scan.skipped.push({ id, reason: "symbolic-link" });
        continue;
      }
      if (!entry.isDirectory()) {
        scan.skipped.push({ id, reason: "not-a-directory" });
        continue;
      }
      const runDir = join(realRoot, id);
      let measured: ReturnType<typeof measureRun>;
      try {
        measured = measureRun(runDir);
      } catch {
        scan.runs.push({ id, decision: "keep", reason: "unreadable", state: null, bytes: 0, newestMs: null, identity: null, torn: false });
        continue;
      }
      const lease = leaseOf(runDir);
      scan.runs.push({
        id,
        decision: lease.held ? "keep" : "delete",
        reason: lease.held ? lease.reason : "quarantine-cleanup",
        state: null,
        bytes: measured.bytes,
        newestMs: measured.newestMs,
        identity: measured.identity,
        torn: false,
      });
      continue;
    }
    if (!RUN_ID_PATTERN.test(id)) {
      scan.skipped.push({ id, reason: "not-a-run-id" });
      continue;
    }
    if (entry.isSymbolicLink()) {
      scan.skipped.push({ id, reason: "symbolic-link" });
      continue;
    }
    if (!entry.isDirectory()) {
      scan.skipped.push({ id, reason: "not-a-directory" });
      continue;
    }
    const runDir = join(realRoot, id);
    let measured: ReturnType<typeof measureRun>;
    try {
      measured = measureRun(runDir);
    } catch {
      scan.runs.push({ id, decision: "keep", reason: "unreadable", state: null, bytes: 0, newestMs: null, identity: null, torn: false });
      continue;
    }
    const run: RunEntry = {
      id,
      decision: "keep",
      reason: "",
      state: null,
      bytes: measured.bytes,
      newestMs: measured.newestMs,
      identity: measured.identity,
      torn: false,
    };
    scan.runs.push(run);
    if (id === currentRunId) {
      run.reason = "current";
      continue;
    }
    const lease = leaseOf(runDir);
    if (lease.held) {
      run.reason = lease.reason;
      continue;
    }
    // The fence gives the epoch above the highest it has seen, so a resume would refuse a record above this one: the
    // scan applies the same bound as the replay under ownership, and the two verdicts cannot differ for the same files.
    const epochFloor = epochFloorOf(runDir);
    const verdict = judgeRun(runDir, id, measured.newestMs, cutoffMs, epochFloor + 1);
    run.decision = verdict.decision;
    run.reason = verdict.reason;
    run.state = verdict.state;
    run.torn = verdict.torn;
    if (verdict.decision === "delete") run.epochFloor = epochFloor;
  }
  return scan;
}

// Removes the directory at `path` and everything below it, never following a symbolic link: a link is unlinked
// itself. With `expected` the directory must be the one with that identity, or nothing is removed. `afterLstat` is a
// test-only interlock that runs between the check of an entry and its use. An entry that is already gone (another
// pass removed it) is not an error.
export function removeTree(
  path: string,
  interlock: { afterLstat?: (path: string) => void } = {},
  expected?: FileIdentity,
): void {
  if (process.platform === "linux") {
    removeTreeAnchored(path, interlock, expected);
    return;
  }
  removeTreeByPath(path, interlock, expected);
}

function ignoreMissing(action: () => void): void {
  try {
    action();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertIdentity(actual: FileIdentity, expected: FileIdentity | undefined, what: string): void {
  if (expected !== undefined && (actual.dev !== expected.dev || actual.ino !== expected.ino)) {
    throw new Error(`${what} is not the directory that was scanned`);
  }
}

// Linux: every directory is opened with O_NOFOLLOW|O_DIRECTORY, and its entries are checked and removed through
// /proc/self/fd/<fd>/<name>, which names the opened directory itself. A directory swapped for a symbolic link after
// the check makes the open fail (ELOOP or ENOTDIR) instead of being followed, and rmdir and unlink never follow
// the last component.
function removeTreeAnchored(
  path: string,
  interlock: { afterLstat?: (path: string) => void },
  expected: FileIdentity | undefined,
): void {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
  try {
    assertIdentity(fstatSync(fd), expected, "the directory to remove");
    removeEntriesOf(fd, interlock);
  } finally {
    closeSync(fd);
  }
  ignoreMissing(() => rmdirSync(path));
}

function removeEntriesOf(directoryFd: number, interlock: { afterLstat?: (path: string) => void }): void {
  const anchor = `/proc/self/fd/${directoryFd}`;
  for (const name of readdirSync(anchor)) {
    const entry = `${anchor}/${name}`;
    let stat;
    try {
      stat = lstatSync(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) {
      ignoreMissing(() => unlinkSync(entry));
      continue;
    }
    interlock.afterLstat?.(entry);
    let childFd: number;
    try {
      childFd = openSync(entry, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const opened = fstatSync(childFd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("a directory changed while it was removed");
      removeEntriesOf(childFd, interlock);
    } finally {
      closeSync(childFd);
    }
    ignoreMissing(() => rmdirSync(entry));
  }
}

// macOS: Node has no directory-relative path form there, so walk by path with lstat. The tree is the run directory
// that quarantineRun has already moved out of the runs namespace, under the lock the fence gave this process.
function removeTreeByPath(
  path: string,
  interlock: { afterLstat?: (path: string) => void },
  expected?: FileIdentity,
): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory()) {
    assertIdentity(stat, expected, "the directory to remove");
    interlock.afterLstat?.(path);
    for (const name of ignoreMissingList(path)) removeTreeByPath(join(path, name), interlock);
    ignoreMissing(() => rmdirSync(path));
  } else {
    // Files and symbolic links: a link is unlinked itself, its target is never followed.
    ignoreMissing(() => unlinkSync(path));
  }
}

function ignoreMissingList(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Takes ownership of one run through the runtime's single-writer fence. A live owner, a resume under way and another
// pass all leave the run busy, and then nothing is changed: the run is refused with `refusal`. With `expected` the
// directory must be the one the scan saw: a run replaced by another directory with the same name is refused before
// any lock is created in it.
function takeOwnership(
  runDir: string,
  refusal: string,
  expected?: FileIdentity,
): { fence: FileOwnershipFence; epoch: number } {
  // Opened without following a link, so a run directory swapped for a link fails here; the fence checks the identity again.
  let fd: number;
  try {
    fd = openSync(runDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new Error("run is no longer a plain directory");
    throw error;
  }
  let identity;
  try {
    identity = fstatSync(fd);
  } finally {
    closeSync(fd);
  }
  if (expected !== undefined && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
    throw new Error("run directory was replaced after the scan; left unchanged");
  }
  const fence = new FileOwnershipFence(dirname(runDir), basename(runDir), undefined, {
    path: runDir,
    device: identity.dev,
    inode: identity.ino,
  });
  const acquired = fence.acquireSync();
  if (acquired.outcome !== "acquired") throw new Error(refusal);
  return { fence, epoch: acquired.epoch };
}

// What a step that works on a run directory under ownership gets: the open directory and a way to check its name.
interface AnchoredRun {
  /** A path that names the open directory itself on Linux (/proc/self/fd/<fd>); the path of the directory elsewhere. */
  readonly path: string;
  readonly anchored: boolean;
  /** Operations relative to the open directory (every open adds O_NOFOLLOW); throws where the platform has none. */
  readonly operations: DirectoryOperations;
  /** Throws unless the name of the run still is the directory that is open (device and inode). */
  assertNamed(): void;
}

// The one way gc and repair touch the files of a run after the scan or under ownership. The directory is opened
// without following a link and must be `expected` (device and inode), so a name that was swapped refuses the step
// before anything is read or written; `action` reads and writes through the open directory (`operations`, or `path`
// for the readers that take a path); and with `checkAfter` the name must still be the same directory when the step
// is over, or the result is refused. A step that has changed something on disk checks the name (`assertNamed`)
// before each change instead, and takes `checkAfter` false, because a refusal then could not undo the change.
function withRunDirectory<T>(
  runDir: string,
  expected: FileIdentity,
  action: (run: AnchoredRun) => T,
  checkAfter = true,
): T {
  let fd: number;
  try {
    fd = openSync(runDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new Error("run is no longer a plain directory");
    throw error;
  }
  try {
    assertIdentity(fstatSync(fd), expected, "the run directory");
    const linux = process.platform === "linux";
    const assertNamed = (): void => {
      const named = lstatSync(runDir);
      if (named.dev !== expected.dev || named.ino !== expected.ino) {
        throw new Error("the run directory was replaced while it was in use; left unchanged");
      }
    };
    const run: AnchoredRun = {
      path: linux ? `/proc/self/fd/${fd}` : runDir,
      anchored: linux,
      get operations() {
        return directoryOperations(fd);
      },
      assertNamed,
    };
    const result = action(run);
    if (checkAfter) assertNamed();
    return result;
  } finally {
    closeSync(fd);
  }
}

// A directory cannot be renamed through its open descriptor, so the move is by name: the name is checked right before
// it, and the moved directory is checked right after. When the name was swapped in between, the directory that was
// moved is not the scanned one: it is put back, and nothing is deleted.
function putBackUnlessScanned(runDir: string, moved: string, scanned: FileIdentity): void {
  let identity: FileIdentity | null = null;
  try {
    const stat = lstatSync(moved);
    identity = { dev: stat.dev, ino: stat.ino };
  } catch {
    // Nothing is at the new name; the check below refuses.
  }
  if (identity !== null && identity.dev === scanned.dev && identity.ino === scanned.ino) return;
  try {
    renameSync(moved, runDir);
  } catch {
    // The name is taken again; the moved directory stays under its quarantine name for the operator.
  }
  throw new Error("the run directory was replaced while it was moved; the moved directory was put back");
}

// Moves one run out of the runs namespace while this process owns it, and returns the new path. After the rename
// the run directory name is gone: a later resume of the same run id starts a fresh directory, and nothing can
// reach the moved one by its run id. With `scanned` the run must be the scanned directory and must still be a
// deletable run under ownership; otherwise the lock is released and the run stays as it was.
export function quarantineRun(
  realRoot: string,
  id: string,
  nowMs: number = Date.now(),
  suffix: string = randomBytes(4).toString("hex"),
  scanned?: ScannedRun,
): string {
  const runDir = join(realRoot, id);
  if (!lstatSync(runDir).isDirectory()) throw new Error("run is no longer a plain directory");
  if (realpathSync(runDir) !== runDir) throw new Error("run directory resolves outside the runs root");
  const { fence, epoch } = takeOwnership(runDir, "run is held by a live owner; not removed", scanned?.identity);
  const quarantine = join(realRoot, `${QUARANTINE_PREFIX}${id}-${nowMs}-${suffix}`);
  try {
    if (scanned !== undefined) {
      scanned.afterOwnership?.();
      // Another process took the lock after the scan, even if it changed nothing: it used the run since.
      if (epoch > scanned.epochFloor + 1) throw new Error("run was resumed after the scan; not removed");
      // The verdict of the scan is only a hint: the run may have been resumed and finished since. It is decided
      // again, now that no other process can change it. The files are read through the open directory, so the name
      // cannot be swapped under the reads (Linux; elsewhere by path), and the name must still be the scanned
      // directory at the moment of the move.
      const verdict = withRunDirectory(runDir, scanned.identity, (run) => {
        scanned.afterHandle?.();
        const judged = judgeRun(run.path, id, measureRun(run.path, true, run.anchored).newestMs, scanned.cutoffMs, epoch);
        scanned.afterReads?.();
        return judged;
      });
      if (verdict.decision !== "delete") throw new Error(`run changed after the scan (${verdict.reason}); not removed`);
      assertIdentity(lstatSync(runDir), scanned.identity, "the run directory");
      scanned.beforeMove?.();
    }
    renameSync(runDir, quarantine);
    if (scanned !== undefined) putBackUnlessScanned(runDir, quarantine, scanned.identity);
  } catch (error) {
    // The run stays where it was, so the lock this process took must not stay with it.
    try {
      fence.releaseSync(epoch);
    } catch {
      // The error below is the one to report.
    }
    throw error;
  }
  // The lock moved with the directory; only the descriptor is left to close.
  fence.closeHeldDescriptor();
  return quarantine;
}

// Removes one candidate: a run is quarantined under exclusive ownership and then deleted; a directory that an
// earlier removal left quarantined is deleted unless the lock inside it names a live process. `scanned` binds the
// removal to the directory and the verdict of the scan.
export function removeRun(realRoot: string, id: string, scanned?: ScannedRun): void {
  const runDir = join(realRoot, id);
  if (id.startsWith(QUARANTINE_PREFIX)) {
    if (!lstatSync(runDir).isDirectory()) throw new Error("run is no longer a plain directory");
    if (realpathSync(runDir) !== runDir) throw new Error("run directory resolves outside the runs root");
    if (leaseOf(runDir).held) throw new Error("quarantined run is held by a live process; not removed");
    removeTree(runDir, {}, scanned?.identity);
    return;
  }
  removeTree(quarantineRun(realRoot, id, undefined, undefined, scanned), {}, scanned?.identity);
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function stampFor(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}

// Opens the journal through the open run directory, without following a link. It must be a regular file with no other
// name: a hard link shares its inode with another name, possibly outside the runs root, and truncating it would
// change that file too.
function openJournal(operations: DirectoryOperations, flags: number): number {
  const fd = operations.open(JOURNAL_FILE_NAME, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("journal is not a regular file");
    if (stat.nlink !== 1) throw new Error("journal has more than one hard link; left unchanged");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// Test-only interlocks of repairTornTail, each at a point where the name of the run could be swapped.
export interface RepairInterlock {
  /** The lock is held and no file has been opened yet. */
  readonly afterOwnership?: () => void;
  /** The run directory is open and its identity is checked; the journal is not opened yet. */
  readonly afterHandle?: () => void;
  /** The name was checked for the last time before the torn copy is created. */
  readonly beforeCopy?: () => void;
  /** The torn copy is written and synced; the journal is not truncated yet. */
  readonly afterCopy?: () => void;
  /** The name was checked for the last time before the journal is truncated. */
  readonly beforeTruncate?: () => void;
  /** The repair is done; the lock is not released yet. */
  readonly beforeRelease?: () => void;
}

// Moves the torn last line of one journal to a copy beside it. Complete lines are not touched.
// The copy is written and synced before the journal is truncated, so the tail is never lost.
// The journal is changed only while this process owns the run (the same fence as the removal), so a writer cannot
// append between the last look and the truncation. Every file is opened relative to the open run directory, whose
// identity is the scanned one, so a name that was swapped for a link or for another directory can neither be read nor
// written; the name is checked again before the copy and before the truncation. Returns { repaired, copy }. Throws when
// the run is owned by another process, or the journal is not a private regular file.
export function repairTornTail(
  runDir: string,
  nowMs: number,
  expected?: FileIdentity,
  interlock: RepairInterlock = {},
): { repaired: boolean; copy: string | null } {
  let identity = expected;
  if (identity === undefined) {
    const stat = lstatSync(runDir);
    if (!stat.isDirectory()) throw new Error("run is no longer a plain directory");
    identity = { dev: stat.dev, ino: stat.ino };
  }
  // Looked at before the lock is taken, so a run with nothing to repair, or with a journal that must not be
  // touched, is left exactly as it was.
  const torn = withRunDirectory(runDir, identity, ({ operations }) => {
    const probe = openJournal(operations, fsConstants.O_RDONLY | NONBLOCK);
    try {
      return splitTornTail(readFileSync(probe)).tail.length > 0;
    } finally {
      closeSync(probe);
    }
  });
  if (!torn) return { repaired: false, copy: null };
  const owned = takeOwnership(runDir, "run is held by a live owner; journal left unchanged", identity);
  let outcome: { repaired: boolean; copy: string | null };
  try {
    interlock.afterOwnership?.();
    const ownedIdentity = identity;
    outcome = withRunDirectory(
      runDir,
      ownedIdentity,
      (run) => {
        interlock.afterHandle?.();
        return repairOwnedJournal(run, nowMs, interlock);
      },
      false,
    );
  } catch (error) {
    try {
      owned.fence.releaseSync(owned.epoch);
    } catch {
      // The error below is the one to report; a name that was swapped no longer leads to the lock.
    }
    throw error;
  }
  interlock.beforeRelease?.();
  try {
    owned.fence.releaseSync(owned.epoch);
  } catch (error) {
    throw new Error(`journal repaired${outcome.copy === null ? "" : ` (copy ${outcome.copy})`}; the lock could not be released: ${(error as Error).message}`);
  }
  return outcome;
}

function repairOwnedJournal(
  run: AnchoredRun,
  nowMs: number,
  interlock: RepairInterlock,
): { repaired: boolean; copy: string | null } {
  const { operations } = run;
  const fd = openJournal(operations, fsConstants.O_RDWR);
  try {
    const before = fstatSync(fd);
    const { complete, tail } = splitTornTail(readFileSync(fd));
    if (tail.length === 0) return { repaired: false, copy: null };
    const copyName = `${TORN_COPY_PREFIX}${stampFor(nowMs)}`;
    run.assertNamed();
    interlock.beforeCopy?.();
    const copyFd = operations.open(copyName, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeAll(copyFd, tail);
      fsyncSync(copyFd);
    } finally {
      closeSync(copyFd);
    }
    // The entry of the copy is durable before the journal is shortened.
    operations.sync();
    interlock.afterCopy?.();
    if (fstatSync(fd).size !== before.size) {
      throw new Error("journal changed during repair; left unchanged, torn copy kept");
    }
    run.assertNamed();
    interlock.beforeTruncate?.();
    ftruncateSync(fd, complete.length);
    fsyncSync(fd);
    return { repaired: true, copy: copyName };
  } finally {
    closeSync(fd);
  }
}

// Runs one pass. `remove` is injectable for tests; it defaults to removeRun.
export function runGc(options: GcRunOptions): GcResult {
  const enabled = options.enabled === true;
  const repairRequested = options.repairTornWal === true;
  const nowMs = options.nowMs ?? Date.now();
  const remove = options.remove ?? removeRun;
  const scan = scanRuns({ ...options, nowMs });
  let deleted = 0;
  let failed = 0;
  let candidates = 0;
  let bytesCandidates = 0;
  let bytesDeleted = 0;
  let repaired = 0;
  let repairFailed = 0;
  for (const run of scan.runs) {
    if (run.torn) {
      if (!repairRequested) {
        run.action = "keep";
      } else if (!enabled) {
        run.action = "would-repair";
      } else {
        try {
          const outcome = repairTornTail(join(scan.realRoot as string, run.id), nowMs, run.identity ?? undefined);
          run.action = outcome.repaired ? "repaired" : "keep";
          if (outcome.repaired) {
            run.copy = outcome.copy ?? undefined;
            repaired += 1;
          }
        } catch (error) {
          run.action = "repair-failed";
          run.error = (error as Error).message;
          repairFailed += 1;
        }
      }
      continue;
    }
    if (run.decision !== "delete") {
      run.action = "keep";
      continue;
    }
    candidates += 1;
    bytesCandidates += run.bytes;
    if (!enabled) {
      run.action = "would-delete";
      continue;
    }
    try {
      remove(scan.realRoot as string, run.id, {
        identity: run.identity as FileIdentity,
        cutoffMs: scan.cutoffMs,
        epochFloor: run.epochFloor ?? 0,
      });
      run.action = "deleted";
      deleted += 1;
      bytesDeleted += run.bytes;
    } catch (error) {
      run.action = "failed";
      run.error = (error as Error).message;
      failed += 1;
    }
  }
  return {
    root: scan.root,
    retention_days: scan.retentionDays,
    cutoff_iso: new Date(scan.cutoffMs).toISOString(),
    switch: enabled,
    repair_torn_wal: repairRequested,
    runs: scan.runs.map((run) => ({
      id: run.id,
      action: run.action,
      reason: run.reason,
      state: run.state,
      bytes: run.bytes,
      newest_iso: run.newestMs === null ? null : new Date(run.newestMs).toISOString(),
      ...(run.copy === undefined ? {} : { copy: run.copy }),
      ...(run.error === undefined ? {} : { error: run.error }),
    })),
    skipped: scan.skipped,
    summary: {
      runs: scan.runs.length,
      candidates,
      deleted,
      failed,
      bytes_candidates: bytesCandidates,
      bytes_deleted: bytesDeleted,
      repaired,
      repair_failed: repairFailed,
    },
  };
}

const ACTION_LABEL: Record<string, string> = {
  keep: "KEEP",
  "would-delete": "WOULD-DELETE",
  deleted: "DELETED",
  failed: "FAILED",
  "would-repair": "WOULD-REPAIR",
  repaired: "REPAIRED",
  "repair-failed": "REPAIR-FAILED",
};

export function formatText(result: GcResult): string {
  const lines = [
    `omc graph gc: root=${result.root} retention_days=${result.retention_days} switch=${result.switch ? "on" : "off"} repair_torn_wal=${result.repair_torn_wal ? "on" : "off"}`,
  ];
  if (!result.switch) lines.push(`switch ${GC_SWITCH_ENV} is not "1": nothing is deleted or repaired`);
  for (const run of result.runs) {
    const state = run.state === null ? "" : ` state=${run.state}`;
    const copy = run.copy === undefined ? "" : ` copy=${run.copy}`;
    const error = run.error === undefined ? "" : ` error=${JSON.stringify(run.error)}`;
    lines.push(
      `${ACTION_LABEL[run.action ?? "keep"]} ${run.id} reason=${run.reason}${state} bytes=${run.bytes}${copy}${error}`,
    );
  }
  for (const skipped of result.skipped) {
    lines.push(`SKIP ${JSON.stringify(skipped.id)} reason=${skipped.reason}`);
  }
  const s = result.summary;
  lines.push(
    `summary: runs=${s.runs} candidates=${s.candidates} deleted=${s.deleted} failed=${s.failed} ` +
      `bytes_candidates=${s.bytes_candidates} bytes_deleted=${s.bytes_deleted} ` +
      `repaired=${s.repaired} repair_failed=${s.repair_failed}`,
  );
  return lines.join("\n");
}

export interface GraphGcArgs {
  readonly runsRoot?: string;
  readonly retentionDays?: string;
  readonly current: string | null;
  readonly repairTornWal: boolean;
  readonly json: boolean;
}

interface Writer {
  write(text: string): unknown;
}

/**
 * CLI body of `omc graph gc`. Exit codes: 0 ok, 1 a removal or repair failed,
 * 2 usage or configuration error. `deps.remove` replaces the removal step (tests only).
 */
export function runGraphGc(
  args: GraphGcArgs,
  env: NodeJS.ProcessEnv,
  out: Writer,
  err: Writer,
  deps: { remove?: GcRunOptions["remove"] } = {},
): number {
  let options: {
    runsRoot: string;
    retentionDays: number;
    currentRunId: string | null;
    enabled: boolean;
    repairTornWal: boolean;
  };
  try {
    options = {
      runsRoot: args.runsRoot ?? env[GC_RUNS_ROOT_ENV] ?? DEFAULT_GC_RUNS_ROOT,
      retentionDays:
        args.retentionDays !== undefined
          ? parseRetentionDays(args.retentionDays)
          : parseRetentionDays(env[GC_RETENTION_ENV]),
      currentRunId: args.current,
      enabled: isSwitchOn(env[GC_SWITCH_ENV]),
      repairTornWal: args.repairTornWal || env[GC_REPAIR_ENV] === "1",
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      err.write(`${COMMAND_NAME}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  let result: GcResult;
  try {
    result = runGc({ ...options, remove: deps.remove });
  } catch (error) {
    if (error instanceof ConfigError) {
      err.write(`${COMMAND_NAME}: ${error.message}\n`);
      return 2;
    }
    err.write(`${COMMAND_NAME}: ${(error as Error).message}\n`);
    return 1;
  }
  out.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatText(result)}\n`);
  return result.summary.failed > 0 || result.summary.repair_failed > 0 ? 1 : 0;
}

