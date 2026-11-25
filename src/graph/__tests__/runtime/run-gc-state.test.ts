/**
 * Tests for `omc graph gc`: the state of a run is derived from the replay of its journal, and the snapshot never decides.
 *
 * Every test builds its own runs root in a temporary directory; nothing outside it is touched. The helpers are in
 * run-gc-fixtures.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRun, removeRun, type ScannedRun } from "../../runtime/run-gc.js";
import { readRunStatus } from "../../runtime/run-status.js";
import { writeRealRun, type RealRunKind } from "./real-run-fixtures.js";
import { OLD, OTHER_HASH, activation, ageTree, decisionOf, gc, makeFinishedRun, makeRealRun, makeRoot, removeTempBases, resign, runRuntimeChain, scannedFirst, snapshot, withBase, withBaseAsync } from "./run-gc-fixtures.js";

// Symbolic links need privileges on Windows and the no-follow guarantee is POSIX-only.
const itSymlink = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  removeTempBases();
});

describe("omc graph gc: run states", () => {
  // ---- Run states: the replay of the journal decides, the snapshot never does -------------------

  const STATE_CASES: { kind: RealRunKind; expected: string }[] = [
    { kind: "succeeded", expected: "final-succeeded" },
    { kind: "failed", expected: "final-failed" },
    { kind: "denied", expected: "final-failed" },
    { kind: "ready", expected: "resumable-ready" },
    { kind: "approval", expected: "resumable-approval" },
    // An attempt that was running when the process stopped is never committed, so the replay leaves it ready.
    { kind: "initial", expected: "resumable-ready" },
  ];

  for (const { kind, expected } of STATE_CASES) {
    it(`state ${expected}: ${kind} run`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = makeRealRun(root, "run-state", kind);
        ageTree(dir, OLD);

        const classified = classifyRun(dir, "run-state");
        expect(classified.state).toBe(expected);

        const result = gc(root);
        const run = decisionOf(result, "run-state");
        expect(run.state).toBe(expected);
        if (expected.startsWith("final-")) {
          expect(run.action, "a final run past retention must be removed").toBe("deleted");
          expect(existsSync(dir)).toBe(false);
        } else {
          expect(run.action, "a resumable run must never be removed").toBe("keep");
          expect(run.reason).toBe(expected);
          expect(existsSync(join(dir, "projection.json"))).toBe(true);
        }
      });
    });
  }

  function editSnapshot(dir: string, edit: (envelope: Record<string, any>) => void): void {
    const file = join(dir, "projection.json");
    const envelope = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    edit(envelope);
    writeFileSync(file, JSON.stringify(envelope));
  }

  const setActivationStatus = (status: string) => (envelope: Record<string, any>) => {
    for (const activation of Object.values(envelope.projection.activations) as Record<string, any>[]) activation.status = status;
  };

  // Damage to projection.json. The runtime folds every journal record and treats the snapshot as a status cache, so
  // none of these changes the verdict of a run whose journal replays.
  const SNAPSHOT_DAMAGE: { name: string; damage: (dir: string) => void }[] = [
    { name: "missing", damage: (dir) => rmSync(join(dir, "projection.json")) },
    { name: "not JSON", damage: (dir) => writeFileSync(join(dir, "projection.json"), "not json") },
    { name: "older than the journal", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.saved_at_seq = -1; }) },
    { name: "bound to another descriptor", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.descriptor_hash = OTHER_HASH; }) },
    { name: "naming another run", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.projection.run_id = "other-run"; }) },
    { name: "restored with every activation failed, at the right seq", damage: (dir) => editSnapshot(dir, setActivationStatus("failed")) },
    { name: "restored with every activation completed, at the right seq", damage: (dir) => editSnapshot(dir, setActivationStatus("completed")) },
    { name: "restored with every activation ready, at the right seq", damage: (dir) => editSnapshot(dir, setActivationStatus("ready")) },
    { name: "valid JSON with an emptied body", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.projection.activations = {}; }) },
    { name: "valid JSON with an unknown activation status", damage: (dir) => editSnapshot(dir, setActivationStatus("paused")) },
  ];

  for (const { kind, expected } of [
    { kind: "succeeded" as const, expected: "final-succeeded" },
    { kind: "failed" as const, expected: "final-failed" },
    { kind: "ready" as const, expected: "resumable-ready" },
    { kind: "approval" as const, expected: "resumable-approval" },
  ]) {
    for (const { name, damage } of SNAPSHOT_DAMAGE) {
      it(`a ${kind} run is ${expected} whatever its snapshot is: ${name}`, () => {
        withBase((base) => {
          const root = makeRoot(base);
          const dir = makeRealRun(root, "run-cache", kind);
          damage(dir);
          ageTree(dir, OLD);
          expect(classifyRun(dir, "run-cache").state).toBe(expected);

          const run = decisionOf(gc(root), "run-cache");
          expect(run.state).toBe(expected);
          if (expected.startsWith("final-")) {
            expect(run.action).toBe("deleted");
            expect(existsSync(dir)).toBe(false);
          } else {
            expect(run.action, "a resumable run was removed on the word of its snapshot").toBe("keep");
            expect(existsSync(dir)).toBe(true);
          }
        });
      });
    }
  }

  // Each case leaves one piece of the run unreadable or inconsistent for the replay. Every one must be kept.
  const UNKNOWN_CASES: {
    name: string;
    reason: string;
    build: (root: string, id: string, base: string) => string;
  }[] = [
    {
      name: "descriptor missing",
      reason: "unknown:descriptor-missing",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        rmSync(join(dir, "descriptor.json"));
        return dir;
      },
    },
    {
      name: "descriptor is not JSON",
      reason: "unknown:descriptor-malformed",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        writeFileSync(join(dir, "descriptor.json"), "{not json");
        return dir;
      },
    },
    {
      name: "descriptor is not a sealed descriptor (the hash does not match)",
      reason: "unknown:descriptor-malformed",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const descriptor = JSON.parse(readFileSync(join(dir, "descriptor.json"), "utf8")) as Record<string, unknown>;
        writeFileSync(join(dir, "descriptor.json"), JSON.stringify({ ...descriptor, goal: "another goal" }));
        return dir;
      },
    },
    {
      name: "descriptor names another run",
      reason: "unknown:descriptor-not-of-run",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const other = writeRealRun(root, "run-other", "succeeded");
        writeFileSync(join(dir, "descriptor.json"), readFileSync(join(other.dir, "descriptor.json")));
        rmSync(other.dir, { recursive: true });
        return dir;
      },
    },
    {
      name: "journal file missing although the snapshot has committed records",
      reason: "unknown:no-history",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        rmSync(join(dir, "journal.jsonl"));
        return dir;
      },
    },
    {
      name: "descriptor without a journal and without the initial snapshot",
      reason: "unknown:no-history",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "initial");
        rmSync(join(dir, "projection.json"));
        return dir;
      },
    },
    {
      name: "journal emptied behind a snapshot that has committed records",
      reason: "unknown:no-history",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        writeFileSync(join(dir, "journal.jsonl"), "");
        return dir;
      },
    },
    {
      name: "journal sequence has a gap",
      reason: "unknown:journal-corrupt",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const lines = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n").filter((line) => line !== "");
        writeFileSync(join(dir, "journal.jsonl"), `${lines[1]}\n`);
        return dir;
      },
    },
    {
      name: "journal record edited after it was committed (fails its fingerprint)",
      reason: "unknown:replay-rejected",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const text = readFileSync(join(dir, "journal.jsonl"), "utf8");
        expect(text).toContain('"output_summary":"succeeded"');
        writeFileSync(join(dir, "journal.jsonl"), text.replace('"output_summary":"succeeded"', '"output_summary":"changed"'));
        return dir;
      },
    },
    {
      name: "journal copied from another run (records bound to another descriptor)",
      reason: "unknown:replay-rejected",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const other = writeRealRun(root, "run-other", "succeeded");
        writeFileSync(join(dir, "journal.jsonl"), other.journal);
        rmSync(other.dir, { recursive: true });
        return dir;
      },
    },
    {
      name: "journal records with epochs that decrease",
      reason: "unknown:replay-rejected",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const [first, second] = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n").filter((line) => line !== "");
        const raised = JSON.parse(first) as Record<string, unknown>;
        raised.epoch = 3;
        // The record is re-signed, so only the epoch rule can refuse the run.
        writeFileSync(join(dir, "journal.jsonl"), `${resign(raised)}\n${second}\n`);
        return dir;
      },
    },
    {
      name: "snapshot is a symbolic link",
      reason: "unknown:projection.json-not-a-regular-file",
      build: (root, id, base) => {
        const dir = makeRealRun(root, id, "succeeded");
        const outside = join(base, "outside-projection.json");
        writeFileSync(outside, readFileSync(join(dir, "projection.json")));
        rmSync(join(dir, "projection.json"));
        symlinkSync(outside, join(dir, "projection.json"));
        return dir;
      },
    },
  ];

  for (const unknownCase of UNKNOWN_CASES) {
    const runCase = unknownCase.name === "snapshot is a symbolic link" ? itSymlink : it;
    runCase(`unknown state is kept (fail closed): ${unknownCase.name}`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = unknownCase.build(root, "run-unknown", base);
        ageTree(dir, OLD);
        const before = snapshot(base);

        const result = gc(root);
        const run = decisionOf(result, "run-unknown");
        expect(run.action).toBe("keep");
        expect(run.reason).toBe(unknownCase.reason);
        expect(run.state).toBe("unknown");
        expect(existsSync(dir)).toBe(true);
        expect(snapshot(base), "an unknown run must not be modified").toBe(before);
      });
    });
  }

  it("a journal whose epoch is above the epoch the lock gives is kept in the scan already: a resume would refuse it too", () => {
    withBase((base) => {
      const root = makeRoot(base);
      // No owner.epoch and no lock: the fence hands out epoch 1, and the records say 3.
      const dir = makeRealRun(root, "run-ahead", "succeeded", 3);
      ageTree(dir, OLD);
      const result = gc(root);
      const run = decisionOf(result, "run-ahead");
      // The scan applies the bound the lock would give, so the verdict is the same before and under the lock: kept, not
      // proposed on every pass and refused on every pass (which would end every pass with exit code 1).
      expect(run.action).toBe("keep");
      expect(run.reason).toBe("unknown:replay-rejected");
      expect(result.summary.failed).toBe(0);
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("the replay under ownership is bounded by the epoch the lock gives: records above it, written after the scan, refuse the removal", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeRealRun(root, "run-ahead-late", "succeeded");
      ageTree(dir, OLD);
      const scanned = scannedFirst(root);
      // After the scan the files are replaced by a run whose records carry epoch 3; the fence still hands out epoch 1.
      makeRealRun(root, "run-ahead-late", "succeeded", 3);
      ageTree(dir, OLD);
      expect(() => removeRun(realpathSync(root), "run-ahead-late", scanned)).toThrow(/changed after the scan \(unknown:replay-rejected\)/);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
    });
  });

  // ABA: the reads under the lock must come from the directory that was opened. The name is swapped to a finished copy
  // while they run and swapped back before the check of the name, so only reads through the open directory still see
  // the run that is resumable.
  it.runIf(process.platform === "linux")("the decision reads follow the open directory, not the name: a swap and a swap back during them cannot show a finished run", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-aba");
      ageTree(dir, OLD);
      const finishedCopy = join(base, "finished-copy");
      const parked = join(base, "parked");
      const scanned: ScannedRun = {
        ...scannedFirst(root),
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
    });
  });

  it("gc and status give the state the runtime gives, on runs the runtime wrote", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const cases: { id: string; expected: "succeeded" | "failed" | "in_progress"; chain: Parameters<typeof runRuntimeChain>[2] }[] = [
        { id: "rt-ok", expected: "succeeded", chain: {} },
        { id: "rt-fail", expected: "failed", chain: { failFirst: true } },
        { id: "rt-stopped", expected: "in_progress", chain: { stopAfterFirst: true } },
      ];
      for (const { id, expected, chain } of cases) {
        const result = await runRuntimeChain(root, id, chain);
        const dir = join(root, id);
        const gcState = classifyRun(dir, id).state;
        const status = JSON.parse(readRunStatus({ runId: id, runsRoot: root }).stdout) as { state: string };
        const gcExpected = { succeeded: "final-succeeded", failed: "final-failed", in_progress: "resumable-ready" }[expected];
        expect({ id, terminal: result }, `${id}: the runtime ended it differently`).toEqual({ id, terminal: expected === "in_progress" ? "aborted" : expected });
        expect(gcState, `${id}: gc state`).toBe(gcExpected);
        expect(status.state, `${id}: status state`).toBe(expected);
      }
    });
  });

});
