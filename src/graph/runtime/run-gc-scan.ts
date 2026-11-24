/**
 * The configuration of `omc graph gc` (switch, runs root, retention) and the scan that decides what happens to each
 * run. The scan modifies nothing; its verdict is a hint that removal decides again under ownership. The rules and the
 * safety notes are in run-gc.ts.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RUN_ID_PATTERN } from "./run-dir.js";
import {
  byName,
  epochFloorOf,
  judgeRun,
  leaseOf,
  measureRun,
  QUARANTINE_PREFIX,
  quarantineIdentityOf,
  type FileIdentity,
} from "./run-gc-read.js";

export const GC_SWITCH_ENV = "OMC_GRAPH_GC";
export const GC_RETENTION_ENV = "OMC_GRAPH_RETENTION_DAYS";
export const GC_RUNS_ROOT_ENV = "OMC_GRAPH_RUNS_ROOT";
export const GC_REPAIR_ENV = "OMC_GRAPH_REPAIR_TORN_WAL";
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_GC_RUNS_ROOT = join(".omc", "graph-runs");

const MAX_RETENTION_DAYS = 36500;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ConfigError extends Error {}

export interface RunEntry {
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
      // Only a directory that is the one the name says was checked and moved is cleaned up; any other was never checked.
      const evidence = quarantineIdentityOf(id);
      const verified = evidence !== null && evidence.dev === measured.identity.dev && evidence.ino === measured.identity.ino;
      const deletable = !lease.held && verified;
      scan.runs.push({
        id,
        decision: deletable ? "delete" : "keep",
        reason: lease.held ? lease.reason : verified ? "quarantine-cleanup" : "quarantine-identity-unverified",
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
    const verdict = judgeRun(byName(runDir), id, measured.newestMs, cutoffMs, epochFloor + 1);
    run.decision = verdict.decision;
    run.reason = verdict.reason;
    run.state = verdict.state;
    run.torn = verdict.torn;
    if (verdict.decision === "delete") run.epochFloor = epochFloor;
  }
  return scan;
}
