import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createNikoflowLoopHook,
  readNikoflowState,
  detectDepthFlag,
  stripNikoflowFlags,
  materializePhases,
  NIKOFLOW_PHASES,
} from "../index.js";
import { detectKeywordsWithType } from "../../keyword-detector/index.js";

describe("nikoflow skeleton (TSK-001)", () => {
  let dir: string;
  const sid = "sess-nikoflow-1";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nikoflow-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("keyword detection", () => {
    it("detects the english keyword", () => {
      const kws = detectKeywordsWithType("nikoflow fix the auth bug").map((k) => k.type);
      expect(kws).toContain("nikoflow");
    });
    it("detects the cyrillic alias никофлоу", () => {
      const kws = detectKeywordsWithType("никофлоу почини баг").map((k) => k.type);
      expect(kws).toContain("nikoflow");
    });
    it("does not fire on unrelated text", () => {
      const kws = detectKeywordsWithType("just refactor this file").map((k) => k.type);
      expect(kws).not.toContain("nikoflow");
    });
  });

  describe("depth parsing", () => {
    it("parses nikoflow:deep", () => {
      expect(detectDepthFlag("nikoflow:deep build the thing")).toBe("deep");
    });
    it("parses --tier=standard", () => {
      expect(detectDepthFlag("do it --tier=standard")).toBe("standard");
    });
    it("parses bare --tactical", () => {
      expect(detectDepthFlag("quick fix --tactical")).toBe("tactical");
    });
    it("returns null when no depth given", () => {
      expect(detectDepthFlag("just do the work")).toBeNull();
    });
    it("strips control flags from the task text", () => {
      expect(stripNikoflowFlags("nikoflow:deep  build   the parser")).toBe("build the parser");
    });
  });

  describe("phase materialization", () => {
    it("tactical is the light 2-gate + execute tier", () => {
      expect(materializePhases("tactical")).toEqual(["interview", "execute", "verify"]);
    });
    it("standard runs the full cycle", () => {
      expect(materializePhases("standard")).toEqual(NIKOFLOW_PHASES.standard);
    });
  });

  describe("activation state round-trip", () => {
    it("startLoop writes active state with depth + phases; getState reads it", () => {
      const hook = createNikoflowLoopHook(dir);
      const ok = hook.startLoop(sid, "nikoflow:deep build the parser");
      expect(ok).toBe(true);

      const state = readNikoflowState(dir, sid);
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.depth).toBe("deep");
      expect(state!.phases).toEqual(NIKOFLOW_PHASES.deep);
      expect(state!.phase_index).toBe(0);
      expect(state!.pbt_enabled).toBe(true);
      // control flag stripped from stored prompt
      expect(state!.prompt).toBe("build the parser");
    });

    it("undecided depth stores null depth + empty phases", () => {
      const hook = createNikoflowLoopHook(dir);
      hook.startLoop(sid, "do the work");
      const state = readNikoflowState(dir, sid);
      expect(state!.depth).toBeNull();
      expect(state!.phases).toEqual([]);
    });

    it("cancelLoop clears state for the owning session", () => {
      const hook = createNikoflowLoopHook(dir);
      hook.startLoop(sid, "nikoflow:standard do it");
      expect(readNikoflowState(dir, sid)).not.toBeNull();
      expect(hook.cancelLoop(sid)).toBe(true);
      expect(readNikoflowState(dir, sid)).toBeNull();
    });

    it("session isolation: a different session does not read this state", () => {
      const hook = createNikoflowLoopHook(dir);
      hook.startLoop(sid, "nikoflow:standard do it");
      expect(readNikoflowState(dir, "other-session")).toBeNull();
    });
  });
});
