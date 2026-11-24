/**
 * Tests for `omc graph gc`: the removal of a run: ownership, the decision under the lock, the move and the deletion.
 *
 * Every test builds its own runs root in a temporary directory; nothing outside it is touched. The helpers are in
 * run-gc-fixtures.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileOwnershipFence } from "../../runtime/fence.js";
import { resolveRunDirHandle } from "../../runtime/run-dir.js";
import { quarantineRun, removeRun, removeTree, repairTornTail, runGraphGc, scanRuns, type ScannedRun } from "../../runtime/run-gc.js";
import { CLI_ENTRY, NOW, OLD, REPO_ROOT, SCENARIOS, ageTree, deadPid, decisionOf, finishedJournals, gc, journalText, makeFifo, makeFinishedRun, makeRealRun, makeRoot, makeRun, makeScenarioRun, makeTornRun, removeTempBases, scannedFirst, snapshot, withBase, withBaseAsync } from "./run-gc-fixtures.js";

// Symbolic links need privileges on Windows and the no-follow guarantee is POSIX-only.
const itSymlink = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  removeTempBases();
});

describe("omc graph gc: removal", () => {
  // ---- Removal failures (injected and real guard) ----------------------------------------------

  it("a failed removal is reported, the other expired runs are still removed, and the exit code is 1", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const failing = makeFinishedRun(root, "run-a");
      const removable = makeFinishedRun(root, "run-b");
      ageTree(failing, OLD);
      ageTree(removable, OLD);
      const remove = (realRoot: string, id: string) => {
        if (id === "run-a") throw new Error("simulated removal failure");
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      expect(decisionOf(result, "run-a").action).toBe("failed");
      expect(decisionOf(result, "run-a").error).toBe("simulated removal failure");
      expect(decisionOf(result, "run-b").action).toBe("deleted");
      expect(result.summary.failed).toBe(1);
      expect(result.summary.deleted).toBe(1);
      expect(existsSync(failing), "the run whose removal failed must stay").toBe(true);
      expect(existsSync(removable)).toBe(false);

      let out = "";
      let err = "";
      const code = runGraphGc(
        { runsRoot: root, current: null, repairTornWal: false, json: false },
        { ...process.env, OMC_GRAPH_GC: "1" },
        { write: (text: string) => (out += text) },
        { write: (text: string) => (err += text) },
        { remove },
      );
      expect(code).toBe(1);
      expect(out).toMatch(/^FAILED run-a reason=expired state=final-succeeded bytes=\d+ error="simulated removal failure"/m);
      expect(err).toBe("");
    });
  });

  it("a removal re-checks the owner lock: a run whose lock turned live after the scan is kept", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-raced");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string) => {
        // Simulates a run started between the scan and the removal: its owner lock now names a live process.
        writeFileSync(join(realRoot, id, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 2, timestamp: NOW }));
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-raced");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/held by a live owner/);
      expect(existsSync(dir), "a run with a live owner was removed").toBe(true);
    });
  });

  it("a removal that a contender races after the scan does not take the run: the contender took ownership from a stale owner", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-contended");
      ageTree(dir, OLD);
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const remove = (realRoot: string, id: string) => {
        // The scan saw a dead owner's old lock. Now a resuming process takes the run over through the real fence.
        const contender = new FileOwnershipFence(realRoot, id);
        expect(contender.acquireSync().outcome, "the contender takes over the stale lock").toBe("acquired");
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-contended");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/held by a live owner/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the contended run lost its journal").toBe(journalBefore);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("a removal interrupted after the move leaves a directory the next pass finishes, by the name removeRun gave it", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-original");
      ageTree(dir, OLD);
      // The move that removeRun makes before it deletes; the process stops right after it.
      const quarantine = quarantineRun(realRoot, "run-original", NOW);
      expect(existsSync(dir), "the run directory name must be free after the move").toBe(false);
      expect(existsSync(join(quarantine, "journal.jsonl"))).toBe(true);
      const name = quarantine.slice(realRoot.length + 1);
      // The lock inside names the process that moved the run. It is still alive here (the test process), so the
      // directory is kept; once that process is gone the lock no longer protects it.
      const whileAlive = gc(root);
      expect(decisionOf(whileAlive, name).action).toBe("keep");
      expect(decisionOf(whileAlive, name).reason).toBe("lock-live-pid");
      expect(existsSync(quarantine)).toBe(true);

      writeFileSync(join(quarantine, "owner.lock"), JSON.stringify({ pid: deadPid(), epoch: 2, timestamp: OLD }));
      const result = gc(root);
      expect(decisionOf(result, name).action).toBe("deleted");
      expect(decisionOf(result, name).reason).toBe("quarantine-cleanup");
      expect(result.summary.deleted).toBe(1);
      expect(existsSync(quarantine)).toBe(false);
    });
  });

  it("a leftover quarantined directory whose lock turned live after the scan is kept", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-leftover");
      ageTree(dir, OLD);
      const quarantine = quarantineRun(realRoot, "run-leftover", NOW);
      const name = quarantine.slice(realRoot.length + 1);
      // The scan sees a dead owner, so the leftover is a cleanup candidate.
      writeFileSync(join(quarantine, "owner.lock"), JSON.stringify({ pid: deadPid(), epoch: 2, timestamp: OLD }));
      const remove = (realRootArg: string, id: string) => {
        // Between the scan and the removal a live process now holds the lock inside the leftover.
        writeFileSync(join(realRootArg, id, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 3, timestamp: NOW }));
        removeRun(realRootArg, id);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, name);
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/quarantined run is held by a live process/);
      expect(existsSync(join(quarantine, "journal.jsonl")), "a leftover held by a live process was deleted").toBe(true);
    });
  });

  it("after the move a contender with the old directory handle cannot lock the moved run, and a new resume starts a fresh directory", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-moved");
      ageTree(dir, OLD);
      const staleHandle = resolveRunDirHandle(realRoot, "run-moved");
      const quarantine = quarantineRun(realRoot, "run-moved", NOW);
      const lockBefore = readFileSync(join(quarantine, "owner.lock"), "utf8");

      await expect(new FileOwnershipFence(realRoot, "run-moved", undefined, staleHandle).acquire()).rejects.toThrow();
      expect(readFileSync(join(quarantine, "owner.lock"), "utf8"), "the moved run's lock changed").toBe(lockBefore);

      const resumed = new FileOwnershipFence(realRoot, "run-moved");
      const got = await resumed.acquire();
      expect(got.outcome).toBe("acquired");
      expect(readdirSync(join(realRoot, "run-moved")).sort(), "a new directory holds the new lock only").toEqual(["owner.epoch", "owner.lock"]);
      expect(existsSync(join(quarantine, "journal.jsonl")), "the moved run was touched").toBe(true);
    });
  });

  it("a move that fails leaves the run where it was and releases the lock this process took", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-stays");
      ageTree(dir, OLD);
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      // The target name is taken by a directory that is not empty, so the rename is refused.
      const ran = lstatSync(dir);
      const taken = join(realRoot, `.deleted-run-stays-${NOW}-fixed-${ran.dev}-${ran.ino}`);
      mkdirSync(taken);
      writeFileSync(join(taken, "occupant"), "x");

      expect(() => quarantineRun(realRoot, "run-stays", NOW, "fixed")).toThrow(/ENOTEMPTY|EEXIST/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run lost its journal").toBe(journalBefore);
      expect(existsSync(join(dir, "owner.lock")), "the lock of the failed move was left in the run").toBe(false);
      expect(readdirSync(taken)).toEqual(["occupant"]);
    });
  });

  // Class: a verdict of the scan is used later than it was read. Every test below puts a change between the scan and
  // the removal. A replacement run is aged and in a final state, so only the directory identity can tell it apart.
  it("a removal does not delete a new run that took the place of the scanned run, even when that run looks expired and final", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-replaced");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string, scanned?: ScannedRun) => {
        // Another pass moved the scanned run away; a new run with the same id was created. The old directory stays
        // on disk here, so its inode number cannot be reused by the new one.
        renameSync(join(realRoot, id), join(base, "moved-away"));
        const replacement = makeFinishedRun(realRoot, id);
        ageTree(replacement, OLD);
        removeRun(realRoot, id, scanned);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-replaced");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/replaced after the scan/);
      expect(existsSync(join(dir, "journal.jsonl")), "the new run was deleted on the verdict of the old one").toBe(true);
      expect(readdirSync(dir).sort(), "the refused run was written to").toEqual(["descriptor.json", "journal.jsonl", "projection.json"]);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("two overlapping passes: the second one, which scanned the same expired run, does not delete the run that replaced it", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-twice");
      ageTree(dir, OLD);
      const first = scannedFirst(root);
      const second = scannedFirst(root);
      // An open descriptor keeps the removed directory's inode allocated, so the new run cannot reuse its number.
      const hold = openSync(dir, "r");
      try {
        removeRun(realRoot, "run-twice", first);
        expect(existsSync(dir)).toBe(false);
        const fresh = makeFinishedRun(root, "run-twice");
        ageTree(fresh, OLD);

        expect(() => removeRun(realRoot, "run-twice", second)).toThrow(/replaced after the scan/);
        expect(readFileSync(join(fresh, "journal.jsonl"), "utf8")).toBe(finishedJournals.get(fresh));
        expect(existsSync(join(fresh, "owner.lock")), "a lock was created in the new run").toBe(false);
      } finally {
        closeSync(hold);
      }
    });
  });

  it("a run that was resumed and finished after the scan is decided again under ownership: it is fresh, so it stays", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-resumed");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string, scanned?: ScannedRun) => {
        // The same directory: a resume wrote to it and released its lock. Its files are recent now.
        const now = new Date();
        utimesSync(join(realRoot, id, "journal.jsonl"), now, now);
        removeRun(realRoot, id, scanned);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-resumed");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/changed after the scan \(fresh\)/);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "owner.lock")), "the lock taken for the check was left in the run").toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("a run that is no longer final under ownership stays: the scan's verdict is not reused", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-reopened");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string, scanned?: ScannedRun) => {
        // Same directory, now a run stopped between two steps (the second is ready); its files keep their old times.
        makeRealRun(realRoot, id, "ready");
        ageTree(join(realRoot, id), OLD);
        removeRun(realRoot, id, scanned);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-reopened");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/changed after the scan \(resumable-ready\)/);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "owner.lock"))).toBe(false);
    });
  });

  it("a run that another process locked and released after the scan, changing nothing, is kept: the lock epoch moved", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-touched");
      ageTree(dir, OLD);
      // A resume that finds the run already finished takes the lock, changes no file and releases it.
      const first = new FileOwnershipFence(realpathSync(root), "run-touched");
      const taken = first.acquireSync();
      expect(taken.outcome).toBe("acquired");
      if (taken.outcome === "acquired") first.releaseSync(taken.epoch);
      ageTree(dir, OLD);
      const scannedBefore = scannedFirst(root);
      // The scan above already saw the first epoch; a second touch happens after it.
      const second = new FileOwnershipFence(realpathSync(root), "run-touched");
      const again = second.acquireSync();
      if (again.outcome === "acquired") second.releaseSync(again.epoch);
      ageTree(dir, OLD);

      expect(() => removeRun(realpathSync(root), "run-touched", scannedBefore)).toThrow(/resumed after the scan/);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "owner.lock")), "the lock taken for the check was left in the run").toBe(false);
    });
  });

  it("without a touch after the scan the same run is removed although its epoch sidecar is recent", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-quiet");
      ageTree(dir, OLD);
      const first = new FileOwnershipFence(realpathSync(root), "run-quiet");
      const taken = first.acquireSync();
      if (taken.outcome === "acquired") first.releaseSync(taken.epoch);
      ageTree(dir, OLD);

      removeRun(realpathSync(root), "run-quiet", scannedFirst(root));
      expect(existsSync(dir)).toBe(false);
    });
  });

  it.runIf(process.platform === "linux")("a swap of the run's name after the lock is held is refused by identity before the run is decided again", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-swapped-late");
      ageTree(dir, OLD);
      const swapped: ScannedRun = {
        ...scannedFirst(root),
        afterOwnership: () => {
          renameSync(dir, join(base, "moved-away"));
          makeScenarioRun(root, "run-swapped-late", SCENARIOS.running);
          ageTree(dir, OLD);
        },
      };

      expect(() => removeRun(realRoot, "run-swapped-late", swapped)).toThrow(/not the directory that was scanned/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run that took the name was changed").toBe(journalText(1));
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it.runIf(process.platform === "linux")("the run is decided again from the directory that was opened: a swap of the name while it is read changes nothing it reads", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-swapped-reading");
      ageTree(dir, OLD);
      const swapped: ScannedRun = {
        ...scannedFirst(root),
        afterHandle: () => {
          // The directory is open and was checked. The name now leads to an interrupted run; reads by path would see
          // that run and keep it. The reads of the open directory still see the finished one, and the result is
          // refused because the name no longer is the directory that was read.
          renameSync(dir, join(base, "moved-away"));
          makeScenarioRun(root, "run-swapped-reading", SCENARIOS.running);
          ageTree(dir, OLD);
        },
      };

      expect(() => removeRun(realRoot, "run-swapped-reading", swapped)).toThrow(/replaced while it was in use/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run that took the name was changed").toBe(journalText(1));
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("a leftover directory that was replaced after the scan is not deleted", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-left");
      ageTree(dir, OLD);
      const leftover = quarantineRun(realRoot, "run-left", NOW, "aaaa");
      const name = leftover.slice(realRoot.length + 1);
      writeFileSync(join(leftover, "owner.lock"), JSON.stringify({ pid: deadPid(), epoch: 2, timestamp: OLD }));
      const scanned = scannedFirst(root);
      renameSync(leftover, join(base, "moved-away"));
      const replacement = makeRun(root, name, { "descriptor.json": "{}\n", "journal.jsonl": "other\n" });

      expect(() => removeRun(realRoot, name, scanned)).toThrow(/not the directory that was scanned/);
      expect(readFileSync(join(replacement, "journal.jsonl"), "utf8")).toBe("other\n");
    });
  });

  // Class: a quarantine name is the only evidence that a later pass has about what is under it. The name carries the
  // identity of the directory that was checked and moved; a directory that took its place, or a name without that
  // evidence, is never deleted by the cleanup of leftovers.
  it("a directory under a quarantine name that does not carry the identity of the checked run is kept, with a live replacement or not", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeRun(root, `.deleted-run-claimed-${NOW}-aaaa`, { "descriptor.json": "{}\n", "journal.jsonl": "other\n" });
      const wrongEvidence = makeRun(root, `.deleted-run-claimed-${NOW}-bbbb-1-2`, { "descriptor.json": "{}\n", "journal.jsonl": "other\n" });

      const result = gc(root);
      for (const name of [".deleted-run-claimed-" + NOW + "-aaaa", ".deleted-run-claimed-" + NOW + "-bbbb-1-2"]) {
        expect(decisionOf(result, name).action, name).toBe("keep");
        expect(decisionOf(result, name).reason, name).toBe("quarantine-identity-unverified");
      }
      expect(existsSync(join(dir, "journal.jsonl")), "a directory without evidence was deleted").toBe(true);
      expect(existsSync(join(wrongEvidence, "journal.jsonl")), "a directory with the evidence of another one was deleted").toBe(true);
      expect(() => removeRun(realpathSync(root), `.deleted-run-claimed-${NOW}-aaaa`)).toThrow(/no identity evidence/);
    });
  });

  it.runIf(process.platform === "linux")("a replacement that takes the staging name before the promotion keeps the evidence of the checked run, so the next pass does not delete it", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-promoted");
      ageTree(dir, OLD);
      let swapped = false;
      const scanned: ScannedRun = {
        ...scannedFirst(root),
        beforePromote: () => {
          swapped = true;
          // After the check and before the promotion another process puts a fresh run where the checked one waits.
          const staged = readdirSync(root).filter((name) => name.startsWith(".moving-"));
          expect(staged).toHaveLength(1);
          renameSync(join(root, staged[0]), join(base, "checked-away"));
          makeScenarioRun(root, staged[0], SCENARIOS.ready);
        },
      };

      // The process stops right after the promotion; the next pass finds the leftover with a dead lock.
      const quarantine = quarantineRun(realRoot, "run-promoted", NOW, "fixed", scanned);
      expect(swapped, "the interlock did not run").toBe(true);
      expect(existsSync(join(quarantine, "journal.jsonl"))).toBe(true);
      const result = gc(root);
      expect(decisionOf(result, quarantine.slice(realRoot.length + 1)).action).toBe("keep");
      expect(existsSync(join(quarantine, "journal.jsonl")), "the replacement was deleted on the strength of its name").toBe(true);
    });
  });

  it("a torn journal is repaired only in the directory that was scanned", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-torn-replaced");
      const identity = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW }).runs[0].identity as { dev: number; ino: number };
      renameSync(dir, join(base, "moved-away"));
      const replacement = makeTornRun(root, "run-torn-replaced");
      const before = readFileSync(join(replacement, "journal.jsonl"), "utf8");

      expect(() => repairTornTail(replacement, NOW, identity)).toThrow(/not the directory that was scanned/);
      expect(readFileSync(join(replacement, "journal.jsonl"), "utf8")).toBe(before);
      expect(readdirSync(replacement).sort()).toEqual(["descriptor.json", "journal.jsonl", "projection.json"]);
    });
  });


  // The move of the run out of the runs namespace is a rename by name. The name is checked right before it and the moved
  // directory right after it, so a swap in between puts the wrong directory back instead of deleting it.
  it.runIf(process.platform === "linux")("a name swapped between the last check and the move: what was moved is put back, and nothing is deleted", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-swapped-move");
      ageTree(dir, OLD);
      let replacementJournal = "";
      const swapped: ScannedRun = {
        ...scannedFirst(root),
        beforeMove: () => {
          renameSync(dir, join(base, "moved-away"));
          makeFinishedRun(root, "run-swapped-move");
          ageTree(dir, OLD);
          replacementJournal = readFileSync(join(dir, "journal.jsonl"), "utf8");
        },
      };

      expect(() => removeRun(realRoot, "run-swapped-move", swapped)).toThrow(/replaced while it was moved; the moved directory was put back/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run that took the name was changed").toBe(replacementJournal);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-")), "a run was left in quarantine").toEqual([]);
      expect(existsSync(join(base, "moved-away", "journal.jsonl")), "the scanned directory was changed").toBe(true);
    });
  });

  it("removeTree: an entry that another pass removes after its check is not an error", () => {
    withBase((base) => {
      const tree = join(base, "tree");
      mkdirSync(join(tree, "artifacts"), { recursive: true });
      writeFileSync(join(tree, "artifacts", "inner.txt"), "inner\n");
      writeFileSync(join(tree, "top.txt"), "top\n");
      let raced = false;

      removeTree(tree, {
        afterLstat: (entry) => {
          if (raced) return;
          raced = true;
          // The other pass is faster: the subdirectory is gone before this one opens it.
          rmSync(entry, { recursive: true, force: true });
        },
      });
      expect(raced, "the interlock did not run").toBe(true);
      expect(existsSync(tree)).toBe(false);
    });
  });

  it.runIf(process.platform === "linux")("removeTree: a subdirectory swapped for a symbolic link after its check is not followed", () => {
    withBase((base) => {
      const tree = join(base, "tree");
      mkdirSync(join(tree, "artifacts"), { recursive: true });
      writeFileSync(join(tree, "artifacts", "inner.txt"), "inner\n");
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "victim.txt"), "outside content\n");
      const before = snapshot(outside);
      let swapped = false;

      expect(() =>
        removeTree(tree, {
          afterLstat: (entry) => {
            if (swapped) return;
            swapped = true;
            // Between the lstat that saw a directory and the walk into it, a concurrent process swaps in a link.
            rmSync(entry, { recursive: true, force: true });
            symlinkSync(outside, entry);
          },
        }),
      ).toThrow();
      expect(swapped, "the interlock did not run").toBe(true);
      expect(snapshot(outside), "a file outside the removed tree was deleted through the swapped link").toBe(before);
    });
  });

  it("repairTornTail refuses a journal with a second hard link and leaves the other name untouched", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-hardlink");
      const outside = join(base, "outside.jsonl");
      linkSync(join(dir, "journal.jsonl"), outside);
      const before = snapshot(base);

      expect(() => repairTornTail(dir, NOW)).toThrow(/hard link/);
      expect(snapshot(base), "the shared journal or a copy was written").toBe(before);

      const result = gc(root, { repairTornWal: true });
      expect(decisionOf(result, "run-hardlink").action).toBe("repair-failed");
      expect(readFileSync(outside, "utf8"), "the file outside the runs root was truncated").toBe(readFileSync(join(dir, "journal.jsonl"), "utf8"));
      expect(readFileSync(outside, "utf8").endsWith('{"seq":1,"epoch":1,"descr')).toBe(true);
    });
  });

  itSymlink("a removal that finds the run replaced by a symbolic link fails and leaves the link target alone", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-swapped");
      ageTree(dir, OLD);
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "outside content\n");
      const before = snapshot(outside);
      const remove = (realRoot: string, id: string) => {
        // Simulates a swap between the scan and the removal: the real directory is replaced by a link.
        rmSync(join(realRoot, id), { recursive: true, force: true });
        symlinkSync(outside, join(realRoot, id));
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-swapped");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/no longer a plain directory/);
      expect(lstatSync(dir).isSymbolicLink()).toBe(true);
      expect(snapshot(outside), "the link target was modified").toBe(before);
    });
  });

  it.skipIf(process.platform === "win32")("a FIFO in place of descriptor.json is kept and does not block the command", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-fifo");
      rmSync(join(dir, "descriptor.json"), { force: true });
      makeFifo(join(dir, "descriptor.json"));
      ageTree(dir, OLD);
      // Run in a child process: an open() that blocks on a FIFO would hang the test worker itself.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OMC_GRAPH_")));
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "graph", "gc", "--runs-root", root],
        { cwd: REPO_ROOT, env: { ...env, OMC_GRAPH_GC: "1" }, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
      );
      expect(cli.signal, `the command hung on the FIFO: ${cli.stderr}`).toBeNull();
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toMatch(/^KEEP run-fifo reason=unknown:descriptor\.json-not-a-regular-file/m);
      expect(existsSync(dir), "a run with a FIFO in place of a file was removed").toBe(true);
    });
  }, 90_000);
});
