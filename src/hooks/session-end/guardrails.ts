/**
 * Chain-level guardrails for factory automation (spec: 软件工厂闭环 T3).
 *
 * Two checks, consumed by the spawn stage (T2) before launching the next
 * chained session:
 * - Serial single-session: at most one active session per intent chain,
 *   via an exclusive long-lived file lock (src/lib/file-lock.ts).
 * - Daily cap: at most N links per intent per local calendar day; the
 *   counter persists across sessions under the OMC state root.
 *
 * Rejections leave an audit marker (留痕) on disk.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import {
  acquireFileLockSync,
  releaseFileLockSync,
  type FileLockHandle,
} from "../../lib/file-lock.js";
import { getOmcRoot } from "../../lib/worktree-paths.js";

/** Chain-level cap: links per intent per local calendar day (mission brief #8). */
export const DAILY_CHAIN_LIMIT = 10;

/** Read the effective daily cap: `OMC_DAILY_CHAIN_LIMIT` env override, else the default. */
export function dailyChainLimit(): number {
  // Floor before validating: a fractional override like "0.5" would otherwise
  // floor to 0 and silently block every chain link (count >= 0 is always true).
  const raw = Math.floor(Number(process.env.OMC_DAILY_CHAIN_LIMIT));
  return Number.isFinite(raw) && raw >= 1 ? raw : DAILY_CHAIN_LIMIT;
}

/**
 * intentIds land in lock/stop-marker file names, so the charset is a security
 * boundary: word chars, dot, hyphen only — no separators, no traversal.
 */
export const INTENT_ID_PATTERN = /^[\w.-]{1,256}$/;

/** Long-lived serial lock: a live owner is never stale (isLockStale requires a dead pid). */
const SERIAL_STALE_MS = 24 * 60 * 60 * 1000;

export interface ChainSlotPermit {
  intentId: string;
  serialLock: FileLockHandle;
  dateKey: string;
  linkIndex: number;
}

export type ChainSlotRejection = {
  allowed: false;
  reason: "serial-conflict" | "daily-cap" | "invalid-intent-id";
  detail: string;
};

export type ChainSlotResult = ({ allowed: true } & ChainSlotPermit) | ChainSlotRejection;

interface UsageEntry {
  date: string;
  count: number;
}

interface UsageFile {
  [intentId: string]: UsageEntry | undefined;
}

interface StopMarker {
  intentId: string;
  reason: string;
  dateKey: string;
  count: number;
  stoppedAt: string;
}

/** Local calendar day key, e.g. 2026-09-28. */
export function chainDayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function factoryStateDir(stateRoot?: string): string {
  return stateRoot ?? join(getOmcRoot(), "state", "factory");
}

function usagePath(stateRoot?: string): string {
  return join(factoryStateDir(stateRoot), "chain-usage.json");
}

function stopMarkerPath(intentId: string, stateRoot?: string): string {
  return join(factoryStateDir(stateRoot), `chain-${intentId}.stopped.json`);
}

function readUsageFile(stateRoot?: string): UsageFile {
  try {
    return JSON.parse(readFileSync(usagePath(stateRoot), "utf-8")) as UsageFile;
  } catch {
    return {};
  }
}

/**
 * Claim the right to launch the next chained session for an intent.
 *
 * Atomically (under the usage file's short critical-section lock):
 * 1. serial lock — O_EXCL create; held = a link is already active
 * 2. daily counter — reject at the (N+1)th link of the local day, leave a stop marker
 *
 * The serial lock is held until releaseChainSlot. The daily count is NOT
 * decremented on release: each launched link consumes one slot for the day.
 */
export function acquireChainSlot(
  intentId: string,
  stateRoot?: string,
  now: Date = new Date(),
): ChainSlotResult {
  const dir = factoryStateDir(stateRoot);
  if (!INTENT_ID_PATTERN.test(intentId)) {
    return {
      allowed: false,
      reason: "invalid-intent-id",
      detail: `非法 intentId（仅限字母数字点连线下划线，≤256 字符）：${intentId}`,
    };
  }
  mkdirSync(dir, { recursive: true });
  const serialLock = acquireFileLockSync(join(dir, `chain-${intentId}.active.lock`), {
    staleLockMs: SERIAL_STALE_MS,
  });
  if (!serialLock) {
    return {
      allowed: false,
      reason: "serial-conflict",
      detail: `链 ${intentId} 已有活跃会话（串行 v1），本次不发下一环`,
    };
  }

  const usageLock = acquireFileLockSync(join(dir, "chain-usage.json.lock"));
  if (!usageLock) {
    releaseFileLockSync(serialLock);
    return {
      allowed: false,
      reason: "serial-conflict",
      detail: `链 ${intentId} 用量计数被其他进程持有，本次不发下一环`,
    };
  }
  try {
    const dateKey = chainDayKey(now);
    const usage = readUsageFile(stateRoot);
    const entry = usage[intentId];
    const count = entry && entry.date === dateKey ? entry.count : 0;
    const cap = dailyChainLimit();
    if (count >= cap) {
      writeStopMarker(
        { intentId, reason: "daily-cap", dateKey, count, stoppedAt: now.toISOString() },
        stateRoot,
      );
      releaseFileLockSync(serialLock);
      return {
        allowed: false,
        reason: "daily-cap",
        detail: `链 ${intentId} 今日已发 ${count} 环（上限 ${cap}），链停住；告警留痕 ${stopMarkerPath(intentId)}`,
      };
    }
    usage[intentId] = { date: dateKey, count: count + 1 };
    writeFileSync(usagePath(stateRoot), JSON.stringify(usage, null, 2));
    return { allowed: true, intentId, serialLock, dateKey, linkIndex: count + 1 };
  } finally {
    releaseFileLockSync(usageLock);
  }
}

/**
 * Release a claim. Call when the chained session's spawn handoff is done —
 * the permit covers the "one active session" window, not the session runtime.
 */
export function releaseChainSlot(permit: ChainSlotPermit): void {
  releaseFileLockSync(permit.serialLock);
}

/** Read the audit marker left by a daily-cap rejection, if any. */
export function readChainStopMarker(
  intentId: string,
  stateRoot?: string,
): StopMarker | null {
  const p = stopMarkerPath(intentId, stateRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as StopMarker;
  } catch {
    return null;
  }
}

/** Remove a chain's stop marker (after a human re-opens the chain). */
export function clearChainStopMarker(intentId: string, stateRoot?: string): void {
  try {
    unlinkSync(stopMarkerPath(intentId, stateRoot));
  } catch {
    /* already gone */
  }
}

function writeStopMarker(marker: StopMarker, stateRoot?: string): void {
  mkdirSync(factoryStateDir(stateRoot), { recursive: true });
  writeFileSync(stopMarkerPath(marker.intentId, stateRoot), JSON.stringify(marker, null, 2));
}
