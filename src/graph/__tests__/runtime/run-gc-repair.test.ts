/**
 * Tests for `omc graph gc`: the repair of a torn last journal line.
 *
 * Every test builds its own runs root in a temporary directory; nothing outside it is touched. The helpers are in
 * run-gc-fixtures.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileOwnershipFence } from "../../runtime/fence.js";
import { repairTornTail, runGc } from "../../runtime/run-gc.js";
import { FRESH, NOW, OLD, SCENARIOS, ageTree, decisionOf, descriptorFor, gc, journalText, makeFinishedRun, makeRoot, makeRun, makeScenarioRun, makeTornRun, removeTempBases, runCli, snapshot, withBase, withBaseAsync } from "./run-gc-fixtures.js";

// Symbolic links need privileges on Windows and the no-follow guarantee is POSIX-only.
const itSymlink = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  removeTempBases();
});

describe("omc graph gc: torn journal repair", () => {
  it("a torn last line is moved to a copy and the complete lines are unchanged byte for byte", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-torn");
      const journal = join(dir, "journal.jsonl");
      const prefix = journalText(1);
      const prefixHash = createHash("sha256").update(prefix).digest("hex");

      const result = gc(root, { repairTornWal: true, nowMs: NOW });
      const run = decisionOf(result, "run-torn");
      expect(run.action).toBe("repaired");
      expect(run.reason).toBe("torn-wal");
      expect(result.summary.repaired).toBe(1);
      expect(result.summary.repair_failed).toBe(0);

      const after = readFileSync(journal, "utf8");
      expect(createHash("sha256").update(after).digest("hex"), "complete lines changed").toBe(prefixHash);
      expect(after).toBe(prefix);
      const copy = readFileSync(join(dir, run.copy as string), "utf8");
      expect(copy, "the torn tail must be kept in the copy").toBe('{"seq":1,"epoch":1,"descr');
      expect(existsSync(dir), "a repaired run is never removed in the same pass").toBe(true);
    });
  });

  it("a repaired run keeps its torn copy: the next pass keeps the run and does not delete the copy", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-copy");
      gc(root, { repairTornWal: true, nowMs: NOW });
      ageTree(dir, OLD);

      const result = gc(root, { repairTornWal: true, nowMs: NOW + 1000 });
      const run = decisionOf(result, "run-copy");
      expect(run.action).toBe("keep");
      expect(run.reason).toBe("torn-copy-kept");
      expect(readdirSync(dir).filter((name) => name.startsWith("journal.jsonl.torn-")).length).toBe(1);
    });
  });

  it("a torn copy from an earlier repair keeps an expired final run", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-with-copy");
      writeFileSync(join(dir, "journal.jsonl.torn-2026-11-01T00-00-00-000Z"), "partial");
      ageTree(dir, OLD);

      const result = gc(root);
      expect(decisionOf(result, "run-with-copy").reason).toBe("torn-copy-kept");
      expect(existsSync(join(dir, "journal.jsonl.torn-2026-11-01T00-00-00-000Z"))).toBe(true);
    });
  });

  it("dry run: a torn tail is reported as WOULD-REPAIR and nothing is written", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      makeTornRun(root, "run-torn");
      const before = snapshot(base);

      const lib = runGc({ runsRoot: root, retentionDays: 7, enabled: false, repairTornWal: true, nowMs: NOW });
      expect(decisionOf(lib, "run-torn").action).toBe("would-repair");
      expect(snapshot(base)).toBe(before);

      const cli = await runCli(["--runs-root", root, "--repair-torn-wal"]);
      expect(cli.code, cli.err).toBe(0);
      expect(cli.out).toMatch(/^WOULD-REPAIR run-torn reason=torn-wal/m);
      expect(snapshot(base), "CLI dry run changed the tree").toBe(before);
    });
  });

  it("without the repair option a torn tail is kept and left as it is", () => {
    withBase((base) => {
      const root = makeRoot(base);
      makeTornRun(root, "run-torn");
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: false });
      expect(decisionOf(result, "run-torn").action).toBe("keep");
      expect(decisionOf(result, "run-torn").reason).toBe("torn-wal");
      expect(snapshot(base)).toBe(before);
    });
  });

  it("a journal that ends in a newline is not torn and is not touched by repair", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeScenarioRun(root, "run-intact", SCENARIOS.ready);
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: true });
      expect(decisionOf(result, "run-intact").action).toBe("keep");
      expect(decisionOf(result, "run-intact").reason).toBe("fresh");
      expect(result.summary.repaired).toBe(0);
      expect(snapshot(base), "a complete journal was modified").toBe(before);
      expect(
        readdirSync(dir).some((name) => name.startsWith("journal.jsonl.torn-")),
        "a copy was created for a complete journal",
      ).toBe(false);
    });
  });

  it("an empty journal is not torn: repair writes nothing", () => {
    withBase((base) => {
      const root = makeRoot(base);
      makeRun(root, "run-empty", { "descriptor.json": JSON.stringify(descriptorFor("run-empty")), "journal.jsonl": "" });
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: true });
      expect(result.summary.repaired).toBe(0);
      expect(snapshot(base), "an empty journal was modified").toBe(before);
    });
  });

  it("a torn journal with a live owner is not repaired", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-live");
      writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 1, timestamp: FRESH }));
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: true });
      expect(decisionOf(result, "run-live").reason).toBe("lock-live-pid");
      expect(decisionOf(result, "run-live").action).toBe("keep");
      expect(snapshot(base), "a run with a live owner was modified").toBe(before);
    });
  });

  it("a journal holding only a torn line is repaired to empty, and the whole line is kept in the copy", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeRun(root, "run-only-tail", {
        "descriptor.json": JSON.stringify(descriptorFor("run-only-tail")),
        "journal.jsonl": '{"seq":0,"epoch":1',
      });
      const result = gc(root, { repairTornWal: true });
      const run = decisionOf(result, "run-only-tail");
      expect(run.action).toBe("repaired");
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe("");
      expect(readFileSync(join(dir, run.copy as string), "utf8")).toBe('{"seq":0,"epoch":1');
    });
  });

  it("a torn line that stops inside a multi-byte character is copied byte for byte", () => {
    withBase((base) => {
      const root = makeRoot(base);
      // The letter z-with-dot-above (U+017C) is two bytes in UTF-8 (C5 BC). The tail stops after the first byte.
      const tailBytes = Buffer.from([0x7b, 0x22, 0xc5]);
      const dir = makeTornRun(root, "run-utf8", "");
      writeFileSync(join(dir, "journal.jsonl"), Buffer.concat([Buffer.from(journalText(1)), tailBytes]));
      const result = gc(root, { repairTornWal: true });
      const run = decisionOf(result, "run-utf8");
      expect(run.action).toBe("repaired");
      expect(readFileSync(join(dir, run.copy as string))).toEqual(tailBytes);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe(journalText(1));
    });
  });

  it("a repair whose copy name already exists is refused and the journal is unchanged", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-collision");
      const stamp = new Date(NOW).toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(dir, `journal.jsonl.torn-${stamp}`), "earlier copy");
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const result = gc(root, { repairTornWal: true, nowMs: NOW });
      const run = decisionOf(result, "run-collision");
      expect(run.action).toBe("repair-failed");
      expect(run.error).toMatch(/EEXIST/);
      expect(result.summary.repair_failed).toBe(1);
      // The repair owns the run while it works, which leaves the epoch sidecar of the lock protocol; the data stays.
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "a failed repair changed the journal").toBe(journalBefore);
      expect(readFileSync(join(dir, `journal.jsonl.torn-${stamp}`), "utf8")).toBe("earlier copy");
      expect(readdirSync(dir).filter((name) => name.startsWith("journal.jsonl.torn-"))).toEqual([`journal.jsonl.torn-${stamp}`]);
      expect(existsSync(join(dir, "owner.lock")), "the lock taken for the repair was not released").toBe(false);
    });
  });

  it("a repair does not start on a run that a contender took over through the fence after the scan", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-repair-contended");
      ageTree(dir, OLD);
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const contender = new FileOwnershipFence(realpathSync(root), "run-repair-contended");
      expect(contender.acquireSync().outcome).toBe("acquired");

      expect(() => repairTornTail(dir, NOW)).toThrow(/held by a live owner/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the owner's journal was truncated").toBe(journalBefore);
      expect(readdirSync(dir).filter((name) => name.startsWith("journal.jsonl.torn-"))).toEqual([]);
    });
  });

  it("repairTornTail refuses a live owner before it writes any copy", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-direct-live");
      writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 1, timestamp: FRESH }));
      const before = snapshot(base);
      expect(() => repairTornTail(dir, NOW)).toThrow(/held by a live owner/);
      expect(snapshot(base), "a live run was modified or got a copy").toBe(before);
    });
  });

  itSymlink("repairTornTail refuses a symbolic link as the journal", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeRun(root, "run-link-journal", { "descriptor.json": "{}\n" });
      const outside = join(base, "outside.jsonl");
      writeFileSync(outside, `${journalText(1)}{"seq":1`);
      symlinkSync(outside, join(dir, "journal.jsonl"));
      const before = snapshot(base);
      expect(() => repairTornTail(dir, NOW)).toThrow(/ELOOP|symbolic|journal/);
      expect(snapshot(base)).toBe(before);
    });
  });

  it("CLI repair needs both the switch and the repair option; the environment variable works too", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-cli");

      const flagOnly = await runCli(["--runs-root", root, "--repair-torn-wal"], {});
      expect(flagOnly.code, flagOnly.err).toBe(0);
      expect(flagOnly.out).toMatch(/^WOULD-REPAIR run-cli/m);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8").endsWith('{"seq":1,"epoch":1,"descr')).toBe(true);

      const envOnly = await runCli(["--runs-root", root], { OMC_GRAPH_REPAIR_TORN_WAL: "1" });
      expect(envOnly.code, envOnly.err).toBe(0);
      expect(envOnly.out).toMatch(/^WOULD-REPAIR run-cli/m);

      const both = await runCli(["--runs-root", root], { OMC_GRAPH_GC: "1", OMC_GRAPH_REPAIR_TORN_WAL: "1" });
      expect(both.code, both.err).toBe(0);
      expect(both.out).toMatch(/^REPAIRED run-cli reason=torn-wal bytes=\d+ copy=journal\.jsonl\.torn-/m);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe(journalText(1));
    });
  });

});
