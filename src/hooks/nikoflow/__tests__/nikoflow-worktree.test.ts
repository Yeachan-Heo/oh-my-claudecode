import { describe, it, expect } from "vitest";
import {
  ticketWorktreeRelPath,
  ticketWorktreeBranch,
  ticketWorktreeCreateCmd,
  ticketWorktreeMergeCmd,
  ticketWorktreeRemoveCmd,
  getExecuteTicketPrompt,
  NIKOFLOW_DEFAULT_ROLES,
  type NikoflowState,
} from "../index.js";

describe("nikoflow worktree isolation (TSK-011)", () => {
  describe("paths + branch", () => {
    it("worktree path lives under .omc/worktrees", () => {
      expect(ticketWorktreeRelPath("TSK-001")).toBe(".omc/worktrees/TSK-001");
    });
    it("branch is namespaced under nikoflow/", () => {
      expect(ticketWorktreeBranch("TSK-001")).toBe("nikoflow/TSK-001");
    });
    it("sanitizes a dirty ticket id in the path", () => {
      expect(ticketWorktreeRelPath("TSK 001; rm -rf")).toBe(".omc/worktrees/TSK_001__rm_-rf");
    });
  });

  describe("shell commands", () => {
    it("create uses git worktree add off HEAD", () => {
      const c = ticketWorktreeCreateCmd("/repo", "TSK-001");
      expect(c).toContain("worktree add");
      expect(c).toContain("nikoflow/TSK-001");
      expect(c).toContain("HEAD");
    });
    it("merge commits WIP then merges no-ff then removes the worktree", () => {
      const c = ticketWorktreeMergeCmd("/repo", "TSK-001");
      expect(c).toContain("commit");
      expect(c).toContain("merge --no-ff");
      expect(c).toContain("worktree remove");
    });
    it("remove force-removes the worktree and deletes the branch", () => {
      const c = ticketWorktreeRemoveCmd("/repo", "TSK-001");
      expect(c).toContain("worktree remove --force");
      expect(c).toContain("branch -D nikoflow/TSK-001");
    });
  });

  describe("execute prompt enforces delegate + isolate (base rule)", () => {
    const state = (): NikoflowState => ({
      active: true,
      iteration: 1,
      started_at: new Date(0).toISOString(),
      prompt: "x",
      project_path: "/repo",
      depth: "standard",
      phases: ["interview", "adr", "prd", "tickets", "execute", "verify"],
      phase_index: 4,
      roles: NIKOFLOW_DEFAULT_ROLES,
    });

    it("tells the main thread to delegate coding to an executor subagent, not write code itself", () => {
      const p = getExecuteTicketPrompt({ id: "TSK-001", title: "t", acceptance: ["a"] }, state(), "rid").toLowerCase();
      expect(p).toContain("do not write code");
      expect(p).toContain("executor");
      expect(p).toContain("subagent");
    });
    it("names the dedicated worktree and the merge-only-after-approval flow", () => {
      const p = getExecuteTicketPrompt({ id: "TSK-001", title: "t", acceptance: ["a"] }, state(), "rid");
      expect(p).toContain(".omc/worktrees/TSK-001");
      expect(p).toContain("worktree add");
      expect(p.toLowerCase()).toContain("only after");
      expect(p).toContain("merge --no-ff");
    });
    it("routes a codex executor through a Codex-backed Task subagent (foreground)", () => {
      const s = state();
      s.roles = { ...NIKOFLOW_DEFAULT_ROLES, executor: "gpt-5.5" };
      const p = getExecuteTicketPrompt({ id: "TSK-002", title: "t", acceptance: ["a"] }, s, "rid").toLowerCase();
      expect(p).toContain("codex");
      expect(p).toContain("foreground");
    });
  });
});
