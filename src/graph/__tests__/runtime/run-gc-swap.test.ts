/**
 * Tests for `omc graph gc`: a name that is swapped under a step, and the platforms with and without directory-relative operations.
 *
 * Every test builds its own runs root in a temporary directory; nothing outside it is touched. The helpers are in
 * run-gc-fixtures.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeRun, removeTree, repairTornTail, type RepairInterlock, scanRuns, type ScannedRun } from "../../runtime/run-gc.js";
import { KINDS_WITH_OPERATIONS, NOW, OLD, SCENARIOS, ageTree, decisionOf, gc, journalText, makeFinishedRun, makeRealRun, makeRoot, makeScenarioRun, makeTornRun, noOperations, operationCalls, removeTempBases, scannedFirst, snapshot, withBase } from "./run-gc-fixtures.js";

afterEach(() => {
  removeTempBases();
});

describe("omc graph gc: a name swapped under the repair", () => {
  // Class: after ownership is taken, every file of the run is reached through the open, identity-checked directory, never
  // by the name. The name is swapped at each step of the repair; what took the name (a link to a directory outside the
  // runs root, or another real run directory) must never be read, copied or truncated.
  describe.runIf(process.platform === "linux")("a torn journal repair when the name of the run is swapped under it", () => {
    const TORN = '{"seq":1,"epoch":1,"descr';
    type Point = keyof RepairInterlock;
    type Swap = "link to an outside directory" | "another real run directory";

    function swapIn(base: string, root: string, id: string, dir: string, kind: Swap): { target: string } {
      renameSync(dir, join(base, "moved-away"));
      if (kind === "another real run directory") {
        const other = makeTornRun(root, id);
        return { target: other };
      }
      const outside = join(base, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "journal.jsonl"), `${journalText(1)}${TORN}`);
      symlinkSync(outside, dir);
      return { target: outside };
    }

    // For each point: what the original directory (moved away, still open to the repair) looks like afterwards.
    const POINTS: { point: Point; message: RegExp; copy: boolean; truncated: boolean }[] = [
      { point: "afterOwnership", message: /no longer a plain directory|not the directory that was scanned/, copy: false, truncated: false },
      { point: "afterHandle", message: /replaced while it was in use/, copy: false, truncated: false },
      // Swapped after the last check of the name: the copy goes into the directory the repair owns, never into the new one,
      // and the check before the truncation refuses the rest.
      { point: "beforeCopy", message: /replaced while it was in use/, copy: true, truncated: false },
      { point: "afterCopy", message: /replaced while it was in use/, copy: true, truncated: false },
      // Swapped after the check before the truncation: the truncation is on the descriptor of the owned journal, so it
      // completes there; the lock cannot be released through the swapped name, and that is reported.
      { point: "beforeTruncate", message: /journal repaired.*lock could not be released/, copy: true, truncated: true },
      { point: "beforeRelease", message: /journal repaired.*lock could not be released/, copy: true, truncated: true },
    ];
    const KINDS: Swap[] = ["link to an outside directory", "another real run directory"];

    for (const { point, message, copy, truncated } of POINTS) {
      for (const [platform, operationsFor] of KINDS_WITH_OPERATIONS) {
      for (const kind of KINDS) {
        it(`${point} on ${platform}: the name is swapped for a ${kind}; the repair changes nothing that took the name`, () => {
          withBase((base) => {
            const root = makeRoot(base);
            const dir = makeTornRun(root, "run-torn-swap");
            const identity = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW }).runs[0].identity as { dev: number; ino: number };
            let target = "";
            let targetBefore = "";
            const interlock: RepairInterlock = {
              operationsFor,
              [point]: () => {
                target = swapIn(base, root, "run-torn-swap", dir, kind).target;
                targetBefore = snapshot(target);
              },
            };

            expect(() => repairTornTail(dir, NOW, identity, interlock)).toThrow(message);
            expect(snapshot(target), "what took the name was changed").toBe(targetBefore);
            expect(readdirSync(target).filter((name) => name.startsWith("journal.jsonl.torn-")), "a copy appeared where the name leads").toEqual([]);

            const moved = join(base, "moved-away");
            const copies = readdirSync(moved).filter((name) => name.startsWith("journal.jsonl.torn-"));
            expect(copies.length > 0, `copy in the original directory (${copies.join(",")})`).toBe(copy);
            const journal = readFileSync(join(moved, "journal.jsonl"), "utf8");
            expect(journal === journalText(1), "the journal of the original directory was truncated").toBe(truncated);
            if (!truncated) expect(journal).toBe(`${journalText(1)}${TORN}`);
          });
        });
      }
      }
    }

    it("without a swap the same repair copies the tail, truncates the journal and releases the lock", () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = makeTornRun(root, "run-torn-plain");
        const identity = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW }).runs[0].identity as { dev: number; ino: number };
        const points: string[] = [];
        const outcome = repairTornTail(dir, NOW, identity, {
          afterOwnership: () => points.push("owned"),
          afterHandle: () => points.push("open"),
          beforeCopy: () => points.push("checked"),
          afterCopy: () => points.push("copied"),
          beforeTruncate: () => points.push("checked"),
          beforeRelease: () => points.push("done"),
        });
        expect(points).toEqual(["owned", "open", "checked", "copied", "checked", "done"]);
        expect(outcome.repaired).toBe(true);
        expect(readFileSync(join(dir, outcome.copy as string), "utf8")).toBe(TORN);
        expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe(journalText(1));
        expect(existsSync(join(dir, "owner.lock"))).toBe(false);
      });
    });
  });

});


// Class: a platform with directory-relative operations makes every decision under ownership through the open directory,
// the age as well as the state, and removes the tree through it; a platform without them makes none, and the run stays.
// Each test runs on Linux itself and on the stand-in for macOS.
describe.runIf(process.platform === "linux")("decisions and removal under ownership on each kind of platform", () => {
  for (const [platform, operationsFor] of KINDS_WITH_OPERATIONS) {
    it(`${platform}: the state is read from the directory that was opened, not from a name that was swapped and swapped back during the reads`, () => {
      withBase((base) => {
        operationCalls.length = 0;
        const root = makeRoot(base);
        const realRoot = realpathSync(root);
        const dir = makeFinishedRun(root, "run-aba");
        ageTree(dir, OLD);
        const finishedCopy = join(base, "finished-copy");
        const parked = join(base, "parked");
        const scanned: ScannedRun = {
          ...scannedFirst(root),
          operationsFor,
          afterOwnership: () => {
            // Under the lock the run turns out to be resumable: a stopped run with the second step ready.
            makeRealRun(root, "run-aba", "ready");
            ageTree(dir, OLD);
          },
          afterHandle: () => {
            // A finished, expired copy takes the name while the reads run.
            renameSync(dir, parked);
            const copy = makeRealRun(root, "run-aba", "succeeded");
            ageTree(copy, OLD);
            renameSync(copy, finishedCopy);
            renameSync(parked, dir);
            renameSync(dir, parked);
            renameSync(finishedCopy, dir);
          },
          afterReads: () => {
            // And the opened directory gets its name back before the name is checked.
            renameSync(dir, finishedCopy);
            renameSync(parked, dir);
          },
        };

        expect(() => removeRun(realRoot, "run-aba", scanned)).toThrow(/changed after the scan \(resumable-ready\)/);
        expect(existsSync(join(dir, "journal.jsonl")), "the resumable run was removed on what a swapped name showed").toBe(true);
        expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
        if (operationsFor !== undefined) {
          expect(operationCalls, "the files were read through the operations").toContain("open journal.jsonl");
          expect(operationCalls).toContain("readDir");
        }
      });
    });

    it(`${platform}: the age is read from the directory that was opened: a fresh copy that holds the name during the reads does not keep an expired run`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const realRoot = realpathSync(root);
        const dir = makeFinishedRun(root, "run-age");
        ageTree(dir, OLD);
        const parked = join(base, "parked");
        const freshCopy = join(base, "fresh-copy");
        const scanned: ScannedRun = {
          ...scannedFirst(root),
          operationsFor,
          afterHandle: () => {
            // A finished run that changed a moment ago takes the name: reads by name would find it fresh and keep the run.
            renameSync(dir, parked);
            const copy = makeRealRun(root, "run-age", "succeeded");
            renameSync(copy, freshCopy);
            renameSync(freshCopy, dir);
          },
          afterReads: () => {
            renameSync(dir, freshCopy);
            renameSync(parked, dir);
          },
        };

        removeRun(realRoot, "run-age", scanned);
        expect(existsSync(dir), "the expired run was kept on the age of a copy that held its name").toBe(false);
        expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
        expect(existsSync(join(freshCopy, "journal.jsonl")), "what held the name for a moment was removed").toBe(true);
      });
    });

    it(`${platform}: a name that stays swapped during the reads is refused, and what took the name is left alone`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const realRoot = realpathSync(root);
        const dir = makeFinishedRun(root, "run-swapped-reading");
        ageTree(dir, OLD);
        const scanned: ScannedRun = {
          ...scannedFirst(root),
          operationsFor,
          afterHandle: () => {
            renameSync(dir, join(base, "moved-away"));
            makeScenarioRun(root, "run-swapped-reading", SCENARIOS.running);
            ageTree(dir, OLD);
          },
        };
        expect(() => removeRun(realRoot, "run-swapped-reading", scanned)).toThrow(/replaced while it was in use/);
        expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run that took the name was changed").toBe(journalText(1));
        expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
      });
    });

    it(`${platform}: a whole run is removed with its subdirectories, and a link inside it is unlinked with its target left alone`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = makeFinishedRun(root, "run-tree");
        mkdirSync(join(dir, "artifacts", "deep"), { recursive: true });
        writeFileSync(join(dir, "artifacts", "deep", "inner.txt"), "inner\n");
        writeFileSync(join(dir, "artifacts", "top.txt"), "top\n");
        const outside = join(base, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "keep.txt"), "outside content\n");
        symlinkSync(outside, join(dir, "artifacts", "link-to-outside"));
        ageTree(dir, OLD);
        const before = snapshot(outside);

        const result = gc(root, { remove: (realRoot, id, scanned) => removeRun(realRoot, id, { ...scanned, operationsFor } as ScannedRun) });
        expect(decisionOf(result, "run-tree").action, JSON.stringify(result.runs)).toBe("deleted");
        expect(existsSync(dir)).toBe(false);
        expect(readdirSync(root)).toEqual([]);
        expect(snapshot(outside), "the target of a link inside the run was touched").toBe(before);
      });
    });

    it(`${platform}: a subdirectory swapped for a symbolic link after its check is not followed`, () => {
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
            operationsFor,
            afterLstat: (entry) => {
              if (swapped) return;
              swapped = true;
              rmSync(entry, { recursive: true, force: true });
              symlinkSync(outside, entry);
            },
          }),
        ).toThrow();
        expect(swapped, "the interlock did not run").toBe(true);
        expect(snapshot(outside), "a file outside the removed tree was deleted through the swapped link").toBe(before);
      });
    });
  }

  it("a platform without operations decides nothing and removes nothing: the run stays, the lock is released, and the reason is the platform", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-no-operations");
      ageTree(dir, OLD);
      const files = ["descriptor.json", "journal.jsonl", "projection.json"];
      const before = files.map((name) => readFileSync(join(dir, name), "utf8"));

      const result = gc(root, { remove: (realRoot, id, scanned) => removeRun(realRoot, id, { ...scanned, operationsFor: noOperations } as ScannedRun) });
      const run = decisionOf(result, "run-no-operations");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/no directory-relative file operations; the run was left unchanged/);
      expect(existsSync(join(dir, "owner.lock")), "the lock was left behind").toBe(false);
      expect(files.map((name) => readFileSync(join(dir, name), "utf8")), "a file of the run was modified").toEqual(before);
      expect(readdirSync(root), "the run was moved or removed").toEqual(["run-no-operations"]);
    });
  });

  it("a platform without operations repairs nothing and removes no tree", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeScenarioRun(root, "run-no-operations-torn", SCENARIOS.ready, { journal: `${journalText(1)}{"seq":1,"epoch":1,"descr` });
      const identity = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW }).runs[0].identity as { dev: number; ino: number };
      const before = snapshot(base);
      expect(() => repairTornTail(dir, NOW, identity, { operationsFor: noOperations })).toThrow(/no directory-relative file operations/);
      expect(snapshot(base), "the journal or the directory was modified").toBe(before);

      const tree = join(base, "tree");
      mkdirSync(join(tree, "sub"), { recursive: true });
      writeFileSync(join(tree, "sub", "file.txt"), "x\n");
      writeFileSync(join(tree, "top.txt"), "y\n");
      const treeBefore = snapshot(tree);
      expect(() => removeTree(tree, { operationsFor: noOperations })).toThrow(/no directory-relative file operations/);
      expect(snapshot(tree), "something was removed").toBe(treeBefore);
    });
  });
});
