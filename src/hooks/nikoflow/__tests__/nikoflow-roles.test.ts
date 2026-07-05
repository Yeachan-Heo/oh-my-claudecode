import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectRoleFlags,
  resolveRoles,
  isCodexRoleSpec,
  renderReviewerSpawn,
  renderPanel,
  createNikoflowLoopHook,
  readNikoflowState,
  getExecuteTicketPrompt,
  getVerifyPrompt,
  getDepthSelectionPrompt,
  getPhasePrompt,
  NIKOFLOW_DEFAULT_ROLES,
  type NikoflowState,
} from "../index.js";

const state = (roles = NIKOFLOW_DEFAULT_ROLES): NikoflowState => ({
  active: true,
  iteration: 1,
  started_at: new Date(0).toISOString(),
  prompt: "x",
  depth: "standard",
  phases: ["interview", "adr", "prd", "tickets", "execute", "verify"],
  phase_index: 4,
  roles,
});

describe("nikoflow role → model routing (TSK-010)", () => {
  describe("detectRoleFlags", () => {
    it("parses --exec / --architect / --panel", () => {
      const r = detectRoleFlags("do it --exec=sonnet --architect=fable --panel=fable+gpt-5.5");
      expect(r.executor).toBe("sonnet");
      expect(r.architect).toBe("fable");
      expect(r.panel).toEqual(["fable", "gpt-5.5"]);
    });
    it("--qa sets both reviewer and verifier", () => {
      const r = detectRoleFlags("work --qa=codex");
      expect(r.reviewer).toBe("codex");
      expect(r.verifier).toBe("codex");
    });
    it("--reviewer / --verifier override --qa individually", () => {
      const r = detectRoleFlags("--qa=fable --verifier=codex");
      expect(r.reviewer).toBe("fable");
      expect(r.verifier).toBe("codex");
    });
    it("no flags → empty overrides", () => {
      expect(detectRoleFlags("just do the thing")).toEqual({});
    });
    it("ignores an unrecognized model spec (typo) so it can't reach Task model=", () => {
      const r = detectRoleFlags("go --exec=sonet --qa=gpt5");
      expect(r.executor).toBeUndefined(); // "sonet" not whitelisted
      expect(r.reviewer).toBeUndefined();
    });
    it("filters invalid entries out of a panel", () => {
      const r = detectRoleFlags("--panel=fable+bogus+gpt-5.5");
      expect(r.panel).toEqual(["fable", "gpt-5.5"]);
    });
  });

  describe("resolveRoles + defaults", () => {
    it("defaults match the user spec (sonnet exec, fable qa, gpt-5.5 in panel)", () => {
      const r = resolveRoles();
      expect(r.executor).toBe("sonnet");
      expect(r.architect).toBe("fable");
      expect(r.reviewer).toBe("fable");
      expect(r.verifier).toBe("fable");
      expect(r.panel).toContain("gpt-5.5");
    });
    it("overrides win over defaults", () => {
      const r = resolveRoles({ executor: "opus" });
      expect(r.executor).toBe("opus");
      expect(r.reviewer).toBe("fable"); // untouched default
    });
  });

  describe("isCodexRoleSpec", () => {
    it("recognizes codex/gpt-5.5 specs", () => {
      expect(isCodexRoleSpec("gpt-5.5")).toBe(true);
      expect(isCodexRoleSpec("codex")).toBe(true);
      expect(isCodexRoleSpec("fable")).toBe(false);
    });
  });

  describe("rendering", () => {
    it("native reviewer renders a Task subagent on that model + fallback note", () => {
      const s = renderReviewerSpawn("fable");
      expect(s).toContain("Task");
      expect(s).toContain("fable");
      expect(s.toLowerCase()).toContain("opus"); // fallback
    });
    it("codex reviewer renders a Codex-backed Task subagent (never a shell command)", () => {
      const s = renderReviewerSpawn("gpt-5.5");
      expect(s.toLowerCase()).toContain("codex");
      expect(s).toContain("Task");
    });
    it("codex reviewer insists on FOREGROUND (background returns a job id, not the verdict)", () => {
      const s = renderReviewerSpawn("codex").toLowerCase();
      expect(s).toContain("foreground");
      expect(s).toContain("background");
    });
    it("panel renders each model as a Task subagent", () => {
      const s = renderPanel(["fable", "gpt-5.5"]);
      expect(s).toContain("fable");
      expect(s.toLowerCase()).toContain("codex");
    });
  });

  describe("prompt injection", () => {
    it("execute prompt names the executor model + reviewer spawn", () => {
      const p = getExecuteTicketPrompt({ id: "TSK-001", title: "t", acceptance: ["a"] }, state(), "rid");
      expect(p).toContain("sonnet"); // executor
      expect(p).toContain("fable"); // reviewer
    });
    it("verify prompt uses the verifier role", () => {
      const p = getVerifyPrompt(state({ ...NIKOFLOW_DEFAULT_ROLES, verifier: "opus" }), "rid", 1);
      expect(p).toContain("opus");
    });
    it("grilling prompt mentions the divergent-opinion panel", () => {
      const p = getDepthSelectionPrompt(state(), "rid");
      expect(p.toLowerCase()).toContain("divergent");
      expect(p.toLowerCase()).toContain("codex");
    });
    it("adr phase prompt names the architect model", () => {
      const p = getPhasePrompt("adr", state({ ...NIKOFLOW_DEFAULT_ROLES, architect: "opus" }), "rid");
      expect(p.toLowerCase()).toContain("architect");
      expect(p).toContain("opus");
    });
  });

  describe("activation sets roles", () => {
    let dir: string;
    const sid = "sess-roles";
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "nikoflow-roles-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("startLoop records default roles", () => {
      createNikoflowLoopHook(dir).startLoop(sid, "nikoflow build feature");
      expect(readNikoflowState(dir, sid)!.roles!.executor).toBe("sonnet");
    });
    it("startLoop honors role flags", () => {
      createNikoflowLoopHook(dir).startLoop(sid, "nikoflow build --exec=opus --qa=codex");
      const r = readNikoflowState(dir, sid)!.roles!;
      expect(r.executor).toBe("opus");
      expect(r.reviewer).toBe("codex");
    });
  });
});
