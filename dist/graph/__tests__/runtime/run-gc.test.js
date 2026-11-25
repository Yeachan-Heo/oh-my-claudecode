/**
 * Tests for `omc graph gc`: the switch, the configuration and the basic retention rules, through the library and the CLI.
 *
 * Every test builds its own runs root in a temporary directory; nothing outside it is touched. The helpers are in
 * run-gc-fixtures.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RETENTION_DAYS, isSwitchOn, parseRetentionDays, runGc } from "../../runtime/run-gc.js";
import { DAY, FRESH, NOW, OLD, ageTree, deadPid, decisionOf, gc, makeFinishedRun, makeRoot, makeRun, removeTempBases, runCli, snapshot, withBase, withBaseAsync } from "./run-gc-fixtures.js";
// Symbolic links need privileges on Windows and the no-follow guarantee is POSIX-only.
const itSymlink = process.platform === "win32" ? it.skip : it;
afterEach(() => {
    removeTempBases();
});
describe("omc graph gc: switch, configuration and retention", () => {
    // ---- Switch, configuration and basic retention ------------------------------------------------
    it('the switch is on only for exactly "1"', () => {
        expect(isSwitchOn("1")).toBe(true);
        for (const value of ["0", "true", "on", "yes", "", " 1", "1 ", "01", undefined]) {
            expect(isSwitchOn(value), `value ${JSON.stringify(value)} must not switch on`).toBe(false);
        }
    });
    it("retention days: positive integers only, default 7", () => {
        expect(DEFAULT_RETENTION_DAYS).toBe(7);
        expect(parseRetentionDays(undefined)).toBe(7);
        expect(parseRetentionDays("1")).toBe(1);
        expect(parseRetentionDays("36500")).toBe(36500);
        for (const value of ["0", "-1", "abc", "", "7.5", " 7", "1e3", "36501", "99999999"]) {
            expect(() => parseRetentionDays(value), `value ${JSON.stringify(value)} must be refused`).toThrow(/retention days/);
        }
    });
    it("switch off: nothing is deleted or written, both through the library and the CLI", async () => {
        await withBaseAsync(async (base) => {
            const root = makeRoot(base);
            makeFinishedRun(root, "run-old");
            makeRun(root, "run-fresh");
            ageTree(join(root, "run-old"), OLD);
            const before = snapshot(base);
            const removals = [];
            const lib = runGc({
                runsRoot: root,
                retentionDays: 7,
                enabled: false,
                nowMs: NOW,
                remove: (_realRoot, id) => removals.push(id),
            });
            expect(decisionOf(lib, "run-old").action).toBe("would-delete");
            expect(decisionOf(lib, "run-fresh").action).toBe("keep");
            expect(removals, "removal must not be called with the switch off").toEqual([]);
            expect(snapshot(base), "library run with the switch off changed the tree").toBe(before);
            for (const env of [{}, { OMC_GRAPH_GC: "0" }, { OMC_GRAPH_GC: "true" }]) {
                const cli = await runCli(["--runs-root", root], env);
                expect(cli.code, cli.err).toBe(0);
                expect(cli.out).toMatch(/WOULD-DELETE run-old reason=expired/);
                expect(cli.out).toMatch(/nothing is deleted/);
                expect(snapshot(base), `CLI with ${JSON.stringify(env)} changed the tree`).toBe(before);
            }
        });
    });
    it("switch on: an expired final run is removed and a fresh run is kept", () => {
        withBase((base) => {
            const root = makeRoot(base);
            makeFinishedRun(root, "run-old");
            makeRun(root, "run-fresh");
            ageTree(join(root, "run-old"), OLD);
            const result = gc(root);
            expect(decisionOf(result, "run-old").action).toBe("deleted");
            expect(decisionOf(result, "run-old").state).toBe("final-succeeded");
            expect(decisionOf(result, "run-fresh").action).toBe("keep");
            expect(decisionOf(result, "run-fresh").reason).toBe("fresh");
            expect(existsSync(join(root, "run-old"))).toBe(false);
            expect(existsSync(join(root, "run-fresh", "journal.jsonl"))).toBe(true);
            expect(result.summary.deleted).toBe(1);
            expect(result.summary.failed).toBe(0);
        });
    });
    it("a run whose directory looks old but holds one fresh entry is kept", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-mixed");
            ageTree(dir, OLD);
            utimesSync(join(dir, "journal.jsonl"), new Date(FRESH), new Date(FRESH));
            const result = gc(root);
            expect(decisionOf(result, "run-mixed").reason).toBe("fresh");
            expect(existsSync(dir)).toBe(true);
        });
    });
    it("an owner.lock held by a live process keeps an expired run", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-live");
            writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 1, timestamp: OLD }));
            ageTree(dir, OLD);
            const result = gc(root);
            expect(decisionOf(result, "run-live").reason).toBe("lock-live-pid");
            expect(decisionOf(result, "run-live").action).toBe("keep");
            expect(existsSync(dir)).toBe(true);
        });
    });
    it("an owner.lock whose pid is dead does not protect an expired final run", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-stale");
            writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: deadPid(), epoch: 1, timestamp: OLD }));
            ageTree(dir, OLD);
            const result = gc(root);
            expect(decisionOf(result, "run-stale").action).toBe("deleted");
            expect(existsSync(dir)).toBe(false);
        });
    });
    it("an unreadable owner.lock keeps the run (fail closed)", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-garbage");
            writeFileSync(join(dir, "owner.lock"), "not json");
            ageTree(dir, OLD);
            const result = gc(root);
            expect(decisionOf(result, "run-garbage").reason).toBe("lock-unparseable");
            expect(existsSync(dir)).toBe(true);
        });
    });
    it("the current run is kept even when it is expired and final", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-current");
            ageTree(dir, OLD);
            const result = gc(root, { currentRunId: "run-current" });
            expect(decisionOf(result, "run-current").reason).toBe("current");
            expect(existsSync(dir)).toBe(true);
        });
    });
    itSymlink("a symbolic link at the top level of the runs root is never followed or removed", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const outside = join(base, "outside");
            mkdirSync(outside);
            writeFileSync(join(outside, "keep.txt"), "outside content\n");
            symlinkSync(outside, join(root, "run-link"));
            const before = snapshot(outside);
            const result = gc(root);
            expect(result.skipped.some((s) => s.id === "run-link" && s.reason === "symbolic-link")).toBe(true);
            expect(lstatSync(join(root, "run-link")).isSymbolicLink()).toBe(true);
            expect(snapshot(outside)).toBe(before);
        });
    });
    itSymlink("a link inside an expired final run is unlinked and its target survives", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const outside = join(base, "outside");
            mkdirSync(outside);
            writeFileSync(join(outside, "keep.txt"), "outside content\n");
            const dir = makeFinishedRun(root, "run-with-link");
            const link = join(dir, "target-link");
            symlinkSync(outside, link);
            // Old run tree; the outside directory keeps its fresh mtime, so following the link would make the run look fresh.
            ageTree(dir, OLD);
            const before = snapshot(outside);
            const result = gc(root);
            expect(decisionOf(result, "run-with-link").action).toBe("deleted");
            expect(existsSync(dir)).toBe(false);
            expect(snapshot(outside), "the link target was modified").toBe(before);
        });
    });
    itSymlink("a symbolic link as the runs root is refused and nothing below it is removed", async () => {
        await withBaseAsync(async (base) => {
            const real = join(base, "real-graph-runs");
            mkdirSync(join(base, "x", ".omc"), { recursive: true });
            mkdirSync(real);
            const dir = makeFinishedRun(real, "run-old");
            ageTree(dir, OLD);
            symlinkSync(real, join(base, "x", ".omc", "graph-runs"));
            const cli = await runCli(["--runs-root", join(base, "x", ".omc", "graph-runs")], { OMC_GRAPH_GC: "1" });
            expect(cli.code).toBe(2);
            expect(cli.err).toMatch(/symbolic link/);
            expect(existsSync(dir)).toBe(true);
        });
    });
    itSymlink("a linked .omc directory is refused: the resolved runs root must also be named .omc/graph-runs", async () => {
        await withBaseAsync(async (base) => {
            const target = join(base, "E-target");
            const dir = makeFinishedRun(join(target, "graph-runs"), "run-old");
            ageTree(dir, OLD);
            mkdirSync(join(base, "E"));
            symlinkSync(target, join(base, "E", ".omc"));
            const cli = await runCli(["--runs-root", join(base, "E", ".omc", "graph-runs")], { OMC_GRAPH_GC: "1" });
            expect(cli.code).toBe(2);
            expect(cli.err).toMatch(/must resolve to a directory named \.omc\/graph-runs/);
            expect(existsSync(dir), "the run behind the linked .omc was removed").toBe(true);
        });
    });
    it("the runs root must be named .omc/graph-runs", async () => {
        await withBaseAsync(async (base) => {
            const plain = join(base, "other");
            const dir = makeFinishedRun(plain, "run-old");
            ageTree(dir, OLD);
            const wrongParent = join(base, "data", "graph-runs");
            makeFinishedRun(wrongParent, "run-old");
            for (const bad of [plain, wrongParent]) {
                const cli = await runCli(["--runs-root", bad], { OMC_GRAPH_GC: "1" });
                expect(cli.code, `root ${bad} must be refused`).toBe(2);
                expect(cli.err).toMatch(/\.omc\/graph-runs/);
            }
            expect(existsSync(dir)).toBe(true);
        });
    });
    it("an invalid retention value stops the run before anything is deleted", async () => {
        await withBaseAsync(async (base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-old");
            ageTree(dir, OLD);
            for (const args of [["--retention-days", "0"], ["--retention-days", "-1"], ["--retention-days", "abc"]]) {
                const cli = await runCli(["--runs-root", root, ...args], { OMC_GRAPH_GC: "1" });
                expect(cli.code, `args ${args.join(" ")} must be refused`).toBe(2);
                expect(existsSync(dir)).toBe(true);
            }
            const fromEnv = await runCli(["--runs-root", root], { OMC_GRAPH_GC: "1", OMC_GRAPH_RETENTION_DAYS: "" });
            expect(fromEnv.code).toBe(2);
            expect(existsSync(dir)).toBe(true);
        });
    });
    it("entries that are not run ids or not directories are never touched", () => {
        withBase((base) => {
            const root = makeRoot(base);
            const spaced = join(root, "not a run");
            mkdirSync(spaced);
            writeFileSync(join(spaced, "x"), "x");
            writeFileSync(join(root, "stray.txt"), "stray\n");
            ageTree(spaced, OLD);
            utimesSync(join(root, "stray.txt"), new Date(OLD), new Date(OLD));
            const before = snapshot(base);
            const result = gc(root);
            expect(result.summary.candidates).toBe(0);
            expect(result.skipped.some((s) => s.reason === "not-a-run-id")).toBe(true);
            expect(result.skipped.some((s) => s.reason === "not-a-directory")).toBe(true);
            expect(snapshot(base)).toBe(before);
        });
    });
    it("a missing runs root is reported as nothing to do and is not created", async () => {
        await withBaseAsync(async (base) => {
            const cli = await runCli(["--runs-root", join(base, ".omc", "graph-runs")], { OMC_GRAPH_GC: "1" });
            expect(cli.code, cli.err).toBe(0);
            expect(existsSync(join(base, ".omc"))).toBe(false);
        });
    });
    it("CLI with the switch on prints per-run lines and a summary", async () => {
        await withBaseAsync(async (base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-old");
            makeRun(root, "run-fresh");
            ageTree(dir, OLD);
            const cli = await runCli(["--runs-root", root, "--retention-days", "7"], { OMC_GRAPH_GC: "1" });
            expect(cli.code, cli.err).toBe(0);
            expect(cli.out).toMatch(/^DELETED run-old reason=expired state=final-succeeded/m);
            expect(cli.out).toMatch(/^KEEP run-fresh reason=fresh/m);
            expect(cli.out).toMatch(/summary: runs=2 candidates=1 deleted=1 failed=0/);
            expect(existsSync(dir)).toBe(false);
        });
    });
    it("CLI --json gives a machine-readable result with the switch state", async () => {
        await withBaseAsync(async (base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-old");
            ageTree(dir, OLD);
            const cli = await runCli(["--runs-root", root, "--json"]);
            expect(cli.code, cli.err).toBe(0);
            const parsed = JSON.parse(cli.out);
            expect(parsed.switch).toBe(false);
            expect(parsed.retention_days).toBe(7);
            expect(parsed.repair_torn_wal).toBe(false);
            expect(parsed.summary.candidates).toBe(1);
            expect(parsed.summary.deleted).toBe(0);
            expect(decisionOf(parsed, "run-old").action).toBe("would-delete");
            expect(decisionOf(parsed, "run-old").state).toBe("final-succeeded");
            expect(existsSync(dir)).toBe(true);
        });
    });
    it("retention from the environment applies without a flag, and the flag overrides it", async () => {
        await withBaseAsync(async (base) => {
            const root = makeRoot(base);
            const dir = makeFinishedRun(root, "run-ten-days");
            ageTree(dir, NOW - 10 * DAY);
            const fromEnv = await runCli(["--runs-root", root], { OMC_GRAPH_GC: "1", OMC_GRAPH_RETENTION_DAYS: "30" });
            expect(fromEnv.code, fromEnv.err).toBe(0);
            expect(existsSync(dir), "env retention 30 must keep a 10-day-old run").toBe(true);
            const fromFlag = await runCli(["--runs-root", root, "--retention-days", "5"], {
                OMC_GRAPH_GC: "1",
                OMC_GRAPH_RETENTION_DAYS: "30",
            });
            expect(fromFlag.code, fromFlag.err).toBe(0);
            expect(existsSync(dir), "flag retention 5 must remove the 10-day-old run").toBe(false);
        });
    });
});
//# sourceMappingURL=run-gc.test.js.map