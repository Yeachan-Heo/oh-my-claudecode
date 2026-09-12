/**
 * Tests for FileOwnershipFence (graph runtime v2).
 *
 * Covers fresh acquisition, live-holder busy (AC-7), dead-holder takeover
 * with epoch increment (AC-4), atomic release (AC-6), the #3555 interleave
 * probe form (AC-5: at most one winner per dir per round), fenced_out
 * assertion, and stale-grace handling of corrupt locks. Epoch values in the
 * probe are deterministic from the seeded predecessor; strict epoch
 * monotonicity is NOT guaranteed across corrupt-tombstone takeovers
 * (fallback to 2) — ownership safety comes from O_EXCL + atomic rename.
 */
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync, realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

import { afterEach, describe, expect, it } from "vitest";

import { FileOwnershipFence } from "../../runtime/fence.js";
import { FenceError } from "../../runtime/types.js";
import type { FenceLockPayload } from "../../runtime/types.js";

const LOCK_NAME = "owner.lock";
const EPOCH_FILE_NAME = "owner.epoch";

function makeFence(dir: string, staleGraceMs = 1000): FileOwnershipFence {
  return new FileOwnershipFence(dirname(dir), basename(dir), { staleGraceMs });
}

/** PID of a process that has fully exited. */
function spawnDeadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.error || child.pid === undefined) {
    throw new Error("failed to spawn helper process for dead-pid test");
  }
  return child.pid;
}

function craftLock(dir: string, content: string): string {
  const lockPath = join(dir, LOCK_NAME);
  writeFileSync(lockPath, content, "utf8");
  return lockPath;
}

function craftJsonLock(dir: string, payload: FenceLockPayload): string {
  return craftLock(dir, JSON.stringify(payload));
}

/** Backdate mtime so staleness checks are deterministic (no sleeps). */
function backdate(filePath: string, msAgo = 60_000): void {
  const past = new Date(Date.now() - msAgo);
  utimesSync(filePath, past, past);
}

function readLockPayload(dir: string): FenceLockPayload {
  return JSON.parse(readFileSync(join(dir, LOCK_NAME), "utf8")) as FenceLockPayload;
}

describe("FileOwnershipFence", () => {
  const roots: string[] = [];

  /** Fresh runsRoot + run dir under os.tmpdir(); auto-cleaned after each test. */
  function makeRunDir(): string {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "omc-fence-"));
    roots.push(root);
    const dir = join(root, "run-1");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("acquires a fresh run at epoch 1 and reports busy for a second instance", async () => {
    const dir = makeRunDir();

    await expect(makeFence(dir).acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 1,
    });
    expect(readLockPayload(dir)).toMatchObject({ pid: process.pid, epoch: 1 });

    // Live healthy holder in this same process -> fail-closed busy (AC-7).
    await expect(makeFence(dir).acquire()).resolves.toEqual({ outcome: "busy" });
  });

  it("fails closed when the run-directory parent is replaced after acquisition", async () => {
    const dir = makeRunDir();
    const fence = makeFence(dir);
    await expect(fence.acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 1,
    });

    const originalRoot = dirname(dir);
    const outsideRoot = mkdtempSync(join(realpathSync(tmpdir()), "omc-fence-outside-"));
    roots.push(outsideRoot);
    mkdirSync(join(outsideRoot, basename(dir)), { recursive: true });
    renameSync(originalRoot, `${originalRoot}-original`);
    symlinkSync(outsideRoot, originalRoot);
    try {
      expect(() => fence.assertEpoch(1)).toThrow();
      await expect(fence.release(1)).rejects.toThrow("run directory identity changed");
      expect(existsSync(join(outsideRoot, basename(dir), LOCK_NAME))).toBe(false);
    } finally {
      unlinkSync(originalRoot);
      renameSync(`${originalRoot}-original`, originalRoot);
    }
  });

  it("takes over a dead holder's lock at old_epoch + 1 (AC-4)", async () => {
    const dir = makeRunDir();
    craftJsonLock(dir, {
      pid: spawnDeadPid(),
      epoch: 1,
      timestamp: Date.now(),
    });
    backdate(join(dir, LOCK_NAME));

    await expect(makeFence(dir).acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 2,
    });
    expect(readLockPayload(dir)).toMatchObject({
      pid: process.pid,
      epoch: 2,
    });
    expect(readFileSync(join(dir, EPOCH_FILE_NAME), "utf8").trim()).toBe("2");
  });

  it.each(["10garbage", "1garbage", "+10", " 10", "10 ", "1.0", "1e2", "0", "9007199254740992"]) (
    "rejects non-canonical owner.epoch text %j without issuing an epoch",
    async (sidecar) => {
      const dir = makeRunDir();
      writeFileSync(join(dir, EPOCH_FILE_NAME), sidecar, "utf8");

      await expect(makeFence(dir).acquire()).rejects.toThrow("owner.epoch");
      expect(existsSync(join(dir, LOCK_NAME))).toBe(false);
    },
  );

  it("refuses symlinked epoch and lock state instead of reading outside", async () => {
    const dir = makeRunDir();
    const outside = mkdtempSync(join(realpathSync(tmpdir()), "omc-fence-symlink-outside-"));
    roots.push(outside);
    const outsideEpoch = join(outside, EPOCH_FILE_NAME);
    const outsideLock = join(outside, LOCK_NAME);
    writeFileSync(outsideEpoch, "9007199254740992", "utf8");
    writeFileSync(outsideLock, "not json", "utf8");

    symlinkSync(outsideEpoch, join(dir, EPOCH_FILE_NAME));
    await expect(makeFence(dir).acquire()).rejects.toThrow(/ELOOP|symbolic link refused/);

    unlinkSync(join(dir, EPOCH_FILE_NAME));
    symlinkSync(outsideLock, join(dir, LOCK_NAME));
    await expect(makeFence(dir).acquire()).rejects.toThrow(/ELOOP|symbolic link refused/);
    expect(readFileSync(outsideEpoch, "utf8")).toBe("9007199254740992");
    expect(readFileSync(outsideLock, "utf8")).toBe("not json");
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "rejects stale lock epoch %j instead of issuing an unsafe successor",
    async (epoch) => {
      const dir = makeRunDir();
      craftJsonLock(dir, {
        pid: spawnDeadPid(),
        epoch,
        timestamp: Date.now(),
      });
      backdate(join(dir, LOCK_NAME));

      await expect(makeFence(dir).acquire()).rejects.toThrow("stale lock epoch");
      expect(existsSync(join(dir, LOCK_NAME))).toBe(false);
    },
  );

  it("accepts the largest sidecar that still has a safe successor", async () => {
    const dir = makeRunDir();
    writeFileSync(
      join(dir, EPOCH_FILE_NAME),
      String(Number.MAX_SAFE_INTEGER - 1),
      "utf8",
    );

    await expect(makeFence(dir).acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: Number.MAX_SAFE_INTEGER,
    });
  });

  it("fails closed when the sidecar has no safe successor", async () => {
    const dir = makeRunDir();
    writeFileSync(join(dir, EPOCH_FILE_NAME), String(Number.MAX_SAFE_INTEGER), "utf8");

    await expect(makeFence(dir).acquire()).rejects.toThrow("no representable successor");
    expect(existsSync(join(dir, LOCK_NAME))).toBe(false);
  });

  it("does not take over a replacement lock raced into the stale path", async () => {
    const dir = makeRunDir();
    const staleLock = join(dir, LOCK_NAME);
    craftJsonLock(dir, {
      pid: spawnDeadPid(),
      epoch: 1,
      timestamp: Date.now(),
    });
    backdate(staleLock);

    let raced = false;
    const racedFence = new FileOwnershipFence(dirname(dir), basename(dir), {
      staleGraceMs: 1000,
      beforeTakeoverRename: () => {
        if (raced) return;
        raced = true;
        renameSync(staleLock, join(dir, `${LOCK_NAME}.old`));
        craftJsonLock(dir, {
          pid: process.pid,
          epoch: 2,
          timestamp: Date.now(),
        });
      },
    });

    await expect(racedFence.acquire()).resolves.toEqual({ outcome: "busy" });
    expect(readLockPayload(dir)).toMatchObject({ pid: process.pid, epoch: 2 });
    expect(existsSync(join(dir, `${LOCK_NAME}.old`))).toBe(true);
  });

  it("keeps epoch continuity across release/restart via the owner.epoch sidecar", async () => {
    const dir = makeRunDir();

    // Generation 1: seeded dead-pid takeover -> epoch 2 (journal history
    // would hold epoch-2 records after this run).
    craftJsonLock(dir, {
      pid: spawnDeadPid(),
      epoch: 1,
      timestamp: Date.now(),
    });
    backdate(join(dir, LOCK_NAME));
    const first = makeFence(dir);
    await expect(first.acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 2,
    });
    // Run completes normally: only the live lock is removed; the sidecar
    // and journal stay behind.
    await expect(first.release(2)).resolves.toBe(true);
    expect(existsSync(join(dir, LOCK_NAME))).toBe(false);
    expect(existsSync(join(dir, EPOCH_FILE_NAME))).toBe(true);

    // Later resume with no owner.lock: sidecar ceiling 2 forbids reissuing
    // it, so the next holder gets epoch 3 — no fold false-positive against
    // the persisted epoch-2 journal records.
    const second = makeFence(dir);
    await expect(second.acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 3,
    });
    await expect(second.release(3)).resolves.toBe(true);

    // Two-generation positive scenario keeps advancing without repeats.
    await expect(second.acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 4,
    });
    expect(readFileSync(join(dir, EPOCH_FILE_NAME), "utf8").trim()).toBe("4");
  });

  it("releases atomically once and refuses a second release (AC-6)", async () => {
    const dir = makeRunDir();
    const fence = makeFence(dir);
    await fence.acquire();

    await expect(fence.release(1)).resolves.toBe(true);
    expect(existsSync(join(dir, LOCK_NAME))).toBe(false);
    await expect(fence.release(1)).resolves.toBe(false);
  });

  it("refuses to release after an external swap planted a new owner's lock (single-writer)", async () => {
    const dir = makeRunDir();
    const fence = makeFence(dir);
    await fence.acquire();

    // Maintainer probe: externally move our lock away, then plant a
    // replacement epoch-2 lock at the same path.
    renameSync(join(dir, LOCK_NAME), join(dir, `${LOCK_NAME}.stolen`));
    craftJsonLock(dir, { pid: process.pid, epoch: 2, timestamp: Date.now() });

    // Stale holder's release must not touch the replacement owner's lock.
    await expect(fence.release(1)).resolves.toBe(false);
    expect(readLockPayload(dir)).toMatchObject({ pid: process.pid, epoch: 2 });
    expect(existsSync(join(dir, LOCK_NAME))).toBe(true);

    // The same identity guard fences out stale assertions.
    expect(() => fence.assertEpoch(1)).toThrow(FenceError);
  });

  it("restores a replacement lock when release races after identity check", async () => {
    const dir = makeRunDir();
    const lockPath = join(dir, LOCK_NAME);
    let raced = false;
    const fence = new FileOwnershipFence(dirname(dir), basename(dir), {
      beforeReleaseRename: () => {
        if (raced) return;
        raced = true;
        renameSync(lockPath, join(dir, `${LOCK_NAME}.stolen`));
        craftJsonLock(dir, {
          pid: process.pid,
          epoch: 2,
          timestamp: Date.now(),
        });
      },
    });
    await expect(fence.acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 1,
    });

    // The hook replaces owner.lock after the pre-mutation identity check.
    // Release must not delete or overwrite the replacement owner.
    await expect(fence.release(1)).resolves.toBe(false);
    expect(readLockPayload(dir)).toMatchObject({ pid: process.pid, epoch: 2 });
    expect(existsSync(join(dir, `${LOCK_NAME}.stolen`))).toBe(true);
    expect(() => fence.assertEpoch(1)).toThrow(FenceError);
  });

  it("preserves a foreign lock when failed-create cleanup races with replacement", async () => {
    const dir = makeRunDir();
    const lockPath = join(dir, LOCK_NAME);
    const fence = new FileOwnershipFence(dirname(dir), basename(dir), {
      beforeEpochPersist: () => {
        renameSync(lockPath, join(dir, `${LOCK_NAME}.stolen`));
        craftJsonLock(dir, {
          pid: process.pid,
          epoch: 9,
          timestamp: Date.now(),
        });
        throw new Error("injected sidecar failure");
      },
    });

    await expect(fence.acquire()).rejects.toThrow("injected sidecar failure");
    expect(readLockPayload(dir)).toMatchObject({ pid: process.pid, epoch: 9 });
    expect(existsSync(join(dir, `${LOCK_NAME}.stolen`))).toBe(true);
  });

  it("interleave probe: exactly one winner per dir per round (AC-5)", async () => {
    const ROUNDS = 6;
    const dirs = [makeRunDir(), makeRunDir(), makeRunDir()];
    const epochsByDir = new Map<string, number[]>();

    for (let round = 1; round <= ROUNDS; round++) {
      for (const dir of dirs) {
        // Deterministic race form from the #3555 review: pre-seed a dead-pid
        // lock, then start two racers concurrently on the same run dir.
        craftJsonLock(dir, {
          pid: spawnDeadPid(),
          epoch: round,
          timestamp: Date.now(),
        });
        backdate(join(dir, LOCK_NAME));

        const settled = await Promise.allSettled([
          makeFence(dir).acquire(),
          makeFence(dir).acquire(),
        ]);
        const outcomes = settled.map((result) => {
          if (result.status === "rejected") {
            throw result.reason;
          }
          return result.value;
        });

        const winners = outcomes.filter(
          (outcome) => outcome.outcome === "acquired",
        );
        // The loser always observes either a live-pid lock or a fresh one,
        // so exactly one racer wins each round; never both (#3555 invariant:
        // at most one acquired per dir per round).
        expect(winners.length).toBe(1);

        const winner = winners[0];
        if (winner.outcome === "acquired") {
          // Seeded dead holder had epoch=round -> takeover must be round+1.
          expect(winner.epoch).toBe(round + 1);
          const prior = epochsByDir.get(dir) ?? [];
          // Non-repetition here follows from the seeded predecessor value,
          // not from any continuity guarantee: a corrupt-tombstone takeover
          // would legitimately fall back to epoch 2.
          expect(prior).not.toContain(winner.epoch);
          prior.push(winner.epoch);
          epochsByDir.set(dir, prior);
        }
        expect(outcomes.filter((o) => o.outcome === "busy").length).toBe(1);
      }
    }
  });

  it("throws FenceError('fenced_out') for a wrong epoch claim", async () => {
    const dir = makeRunDir();
    const fence = makeFence(dir);
    await fence.acquire();

    let caught: unknown;
    try {
      fence.assertEpoch(2);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FenceError);
    expect((caught as FenceError).code).toBe("fenced_out");

    expect(() => fence.assertEpoch(1)).not.toThrow();
  });

  it("takes over corrupt content older than the grace period", async () => {
    const dir = makeRunDir();
    craftLock(dir, "not json {{{");
    backdate(join(dir, LOCK_NAME));

    // Unparseable tombstone falls back to old_epoch 1 -> acquired at 2.
    await expect(makeFence(dir).acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 2,
    });
  });

  it("reports busy for corrupt content younger than the grace period", async () => {
    const dir = makeRunDir();
    craftLock(dir, "not json {{{"); // fresh mtime

    await expect(makeFence(dir).acquire()).resolves.toEqual({
      outcome: "busy",
    });
  });
});
