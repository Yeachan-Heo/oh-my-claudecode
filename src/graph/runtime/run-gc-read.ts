/**
 * What `omc graph gc` and `omc graph status` read from one run directory: the lease in owner.lock, the files of the
 * run (by name for the scan, relative to the open directory under ownership), and the verdict on a run. Reads only;
 * nothing here changes a run. The rules and the safety notes are in run-gc.ts.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DirectoryOperations } from "./contained-fd.js";
import { classifyRunFiles } from "./run-state.js";

export const LOCK_FILE_NAME = "owner.lock";
const DESCRIPTOR_FILE_NAME = "descriptor.json";
const SNAPSHOT_FILE_NAME = "projection.json";
export const JOURNAL_FILE_NAME = "journal.jsonl";
export const TORN_COPY_PREFIX = `${JOURNAL_FILE_NAME}.torn-`;
export const QUARANTINE_PREFIX = ".deleted-";

// A quarantine name ends with the identity (device and inode) of the directory that was checked to be the scanned run
// and moved: `.deleted-<run id>-<time>-<random>-<dev>-<ino>`. The name is the durable evidence that a later pass needs
// before it deletes a leftover without looking at its content: a directory that took the place of the checked one has
// another inode, and a name without the evidence says nothing about what is under it.
export function quarantineNameFor(id: string, nowMs: number, suffix: string, identity: FileIdentity): string {
  return `${QUARANTINE_PREFIX}${id}-${nowMs}-${suffix}-${identity.dev}-${identity.ino}`;
}

export function quarantineIdentityOf(name: string): FileIdentity | null {
  const match = /-(\d+)-(\d+)$/.exec(name);
  if (!name.startsWith(QUARANTINE_PREFIX) || match === null) return null;
  const identity = { dev: Number(match[1]), ino: Number(match[2]) };
  return Number.isSafeInteger(identity.dev) && Number.isSafeInteger(identity.ino) ? identity : null;
}
// Where a run directory waits right after the move until it is checked to be the scanned one. A pass lists such a name
// as not a run id, so it is never deleted as the leftover of an interrupted removal, however the process ended.
export const STAGING_PREFIX = ".moving-";
const MAX_LOCK_BYTES = 4096;
export const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
export const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

// Loosely typed JSON read from run files; the checks below validate the parts that are used.
type Json = Record<string, any>;

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
export function epochFloorOf(runDir: string): number {
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

// Directory-relative operations for an open directory, or null where the platform has none. Every platform that has
// them (Linux, and macOS with the native module) is read through them; the platform is never told by its name. The
// default asks the contained filesystem layer, and tests replace it to stand in for another platform.
export type OperationsFor = (fd: number) => DirectoryOperations | null;

export const NO_OPERATIONS = "this platform has no directory-relative file operations; the run was left unchanged";

// Read access to one directory of a run. The scan, which only gives hints, reads by name (`byName`). Every decision
// under ownership reads relative to the open directory (`relativeTo`): the name of the run can then be swapped for
// another directory, and even swapped back, without changing what is read.
export interface TreeReader {
  names(): string[];
  /** The entry itself, never what a link points to. */
  stat(name: string): { dev: number; ino: number; mtimeMs: number; size: number; isFile(): boolean; isDirectory(): boolean };
  /** One regular file, read without following a link. */
  read(name: string): Buffer;
  /** Runs `action` on a subdirectory that is the one `seen` describes: a directory swapped for a link or another directory since is refused. */
  enter<T>(name: string, seen: { dev: number; ino: number }, action: (inner: TreeReader) => T): T;
}

export function byName(dir: string): TreeReader {
  return {
    names: () => readdirSync(dir),
    stat: (name) => lstatSync(join(dir, name)),
    read: (name) => readThrough((flags) => openSync(join(dir, name), flags | NOFOLLOW), name),
    enter: (name, _seen, action) => action(byName(join(dir, name))),
  };
}

export function relativeTo(operations: DirectoryOperations, operationsFor: OperationsFor): TreeReader {
  return {
    names: () => operations.readDir(),
    stat: (name) => operations.lstat(name),
    read: (name) => readThrough((flags) => operations.open(name, flags), name),
    enter: (name, seen, action) => {
      const fd = operations.open(name, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== seen.dev || opened.ino !== seen.ino) throw new Error("a directory changed while it was read");
        const inner = operationsFor(fd);
        if (inner === null) throw new Error(NO_OPERATIONS);
        return action(relativeTo(inner, operationsFor));
      } finally {
        closeSync(fd);
      }
    },
  };
}

// Newest modification time and total file size below a run directory. Every entry is read with lstat, so symbolic
// links are never followed. Under ownership (`ownedByFence`) the fence's own entries and the time of the directory
// itself are left out: taking the lock rewrote them just now and say nothing about when the run last changed.
export function measureTree(reader: TreeReader, topMtimeMs: number, ownedByFence: boolean): { newestMs: number; bytes: number } {
  let newestMs = ownedByFence ? 0 : topMtimeMs;
  let bytes = 0;
  const visit = (directory: TreeReader, isTop: boolean): void => {
    for (const name of directory.names()) {
      if (ownedByFence && isTop && isFenceEntry(name)) continue;
      const stat = directory.stat(name);
      newestMs = Math.max(newestMs, stat.mtimeMs);
      if (stat.isFile()) bytes += stat.size;
      if (stat.isDirectory()) directory.enter(name, stat, (inner) => visit(inner, false));
    }
  };
  visit(reader, true);
  return { newestMs, bytes };
}

// Identity, newest modification time and total file size of a run directory, by name: the scan. The directory must be
// a plain directory.
export function measureRun(runDir: string): { newestMs: number; bytes: number; identity: FileIdentity } {
  const top = lstatSync(runDir);
  if (!top.isDirectory()) throw new Error("run is not a plain directory");
  return { ...measureTree(byName(runDir), top.mtimeMs, false), identity: { dev: top.dev, ino: top.ino } };
}

// Reads one regular file through `open`, which never follows a symbolic link. A FIFO or other non-regular file is
// refused right after open (O_NONBLOCK), so it cannot block the command.
function readThrough(open: (flags: number) => number, name: string): Buffer {
  let fd: number;
  try {
    fd = open(fsConstants.O_RDONLY | NONBLOCK);
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

// Reads one regular file below a run directory, by name.
function readRunFile(runDir: string, name: string): Buffer {
  return byName(runDir).read(name);
}

// Splits journal bytes into complete lines and a torn tail (the bytes after the last newline).
export function splitTornTail(bytes: Buffer): { complete: Buffer; tail: Buffer } {
  const cut = bytes.lastIndexOf(0x0a) + 1;
  return { complete: bytes.subarray(0, cut), tail: bytes.subarray(cut) };
}

// Reads one file of a run as text; null when it does not exist.
function readRunText(reader: TreeReader, name: string): string | null {
  try {
    return reader.read(name).toString("utf8");
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
function classifyTree(reader: TreeReader, runId: string, epochCeiling?: number): { state: string; reason: string } {
  try {
    const files = {
      descriptor: readRunText(reader, DESCRIPTOR_FILE_NAME),
      journal: readRunText(reader, JOURNAL_FILE_NAME),
      projection: readRunText(reader, SNAPSHOT_FILE_NAME),
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

export function classifyRun(runDir: string, runId: string, epochCeiling?: number): { state: string; reason: string } {
  return classifyTree(byName(runDir), runId, epochCeiling);
}

// True when the journal's last line is torn. A missing or unreadable journal is not torn.
function hasTornTail(reader: TreeReader): boolean {
  try {
    return splitTornTail(reader.read(JOURNAL_FILE_NAME)).tail.length > 0;
  } catch {
    return false;
  }
}

function hasTornCopy(reader: TreeReader): boolean {
  return reader.names().some((name) => name.startsWith(TORN_COPY_PREFIX));
}

export interface Verdict {
  decision: "keep" | "delete";
  reason: string;
  state: string | null;
  torn: boolean;
}

// The rules that decide a run whose lease is known to be free, in order: a torn journal, a torn copy of an earlier
// repair, a change inside the retention window, then the state. The scan (by name, a hint) and the re-check under
// ownership (relative to the open directory) both use it.
export function judgeRun(reader: TreeReader, id: string, newestMs: number, cutoffMs: number, epochCeiling?: number): Verdict {
  if (hasTornTail(reader)) return { decision: "keep", reason: "torn-wal", state: null, torn: true };
  if (hasTornCopy(reader)) return { decision: "keep", reason: "torn-copy-kept", state: null, torn: false };
  if (newestMs >= cutoffMs) return { decision: "keep", reason: "fresh", state: null, torn: false };
  const verdict = classifyTree(reader, id, epochCeiling);
  if (verdict.state === "final-succeeded" || verdict.state === "final-failed") {
    return { decision: "delete", reason: "expired", state: verdict.state, torn: false };
  }
  return { decision: "keep", reason: verdict.reason, state: verdict.state, torn: false };
}
