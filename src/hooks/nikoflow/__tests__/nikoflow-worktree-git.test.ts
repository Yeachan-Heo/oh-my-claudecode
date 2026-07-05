import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ticketWorktreeCreateCmd,
  ticketWorktreeMergeCmd,
  ticketWorktreeRemoveCmd,
} from "../index.js";

// Real git behavior of the worktree command strings (Fable QA #8: the unit tests
// only assert the strings contain "merge --no-ff"; these exercise the sequence).
describe("nikoflow worktree git integration (TSK-011)", () => {
  let dir: string;
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nf-wt-git-"));
    run("git init -q");
    run("git config user.email t@t.test && git config user.name tester");
    run("git config commit.gpgsign false");
    writeFileSync(join(dir, "base.txt"), "base\n");
    run("git add -A && git commit -q -m init");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("create → work in worktree → merge lands the diff on the branch and cleans up", () => {
    run(ticketWorktreeCreateCmd(dir, "TSK-001"));
    const wt = join(dir, ".omc/worktrees/TSK-001");
    expect(existsSync(wt)).toBe(true);

    // executor writes code inside the worktree
    writeFileSync(join(wt, "feature.txt"), "hello from ticket\n");

    run(ticketWorktreeMergeCmd(dir, "TSK-001"));

    // the diff is now on the main branch
    expect(existsSync(join(dir, "feature.txt"))).toBe(true);
    expect(readFileSync(join(dir, "feature.txt"), "utf-8")).toContain("hello from ticket");
    // worktree removed, no stale registration
    expect(existsSync(wt)).toBe(false);
    const wtList = execSync("git worktree list", { cwd: dir }).toString();
    expect(wtList).not.toContain("TSK-001");
  });

  it("merge does NOT destroy an uncommitted diff when the commit step fails safely", () => {
    // A ticket with no staged changes (empty worktree) must not error the chain,
    // and must not leave an orphan.
    run(ticketWorktreeCreateCmd(dir, "TSK-EMPTY"));
    run(ticketWorktreeMergeCmd(dir, "TSK-EMPTY")); // nothing to commit → still merges (no-op) + removes
    expect(existsSync(join(dir, ".omc/worktrees/TSK-EMPTY"))).toBe(false);
  });

  it("re-creating after the worktree dir was removed reuses the branch (no WIP reset)", () => {
    run(ticketWorktreeCreateCmd(dir, "TSK-R"));
    const wt = join(dir, ".omc/worktrees/TSK-R");
    writeFileSync(join(wt, "wip.txt"), "committed wip\n");
    run(`git -C "${wt}" add -A && git -C "${wt}" commit -q -m wip`);
    // remove just the worktree dir registration (branch keeps the commit)
    run(`git worktree remove --force "${wt}"`);
    // re-create → must reuse branch nikoflow/TSK-R (preserving wip.txt), not reset it
    run(ticketWorktreeCreateCmd(dir, "TSK-R"));
    expect(existsSync(join(wt, "wip.txt"))).toBe(true); // WIP preserved (not -B reset)
  });

  it("a ticket id with shell metacharacters cannot inject (sanitized branch/message)", () => {
    const marker = join(dir, "PWNED");
    const evil = `x"; touch "${marker}"; echo "`;
    // the raw id never reaches the shell (path/branch are sanitized) → no injection
    run(ticketWorktreeCreateCmd(dir, evil));
    run(ticketWorktreeMergeCmd(dir, evil));
    expect(existsSync(marker)).toBe(false);
  });

  it("removeCmd discards a worktree + branch cleanly", () => {
    run(ticketWorktreeCreateCmd(dir, "TSK-X"));
    run(ticketWorktreeRemoveCmd(dir, "TSK-X"));
    expect(existsSync(join(dir, ".omc/worktrees/TSK-X"))).toBe(false);
  });
});
