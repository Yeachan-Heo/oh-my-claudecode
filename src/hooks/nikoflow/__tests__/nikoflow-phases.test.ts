import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createNikoflowLoopHook,
  readNikoflowState,
  getCurrentPhase,
  isNikoflowComplete,
  setNikoflowDepth,
  advanceNikoflowPhase,
  getDepthSelectionPrompt,
  getPhasePrompt,
  NIKOFLOW_PHASES,
  type NikoflowState,
} from "../index.js";

describe("nikoflow phase machine (TSK-002)", () => {
  let dir: string;
  const sid = "sess-phases-1";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nikoflow-phases-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (prompt: string) => {
    createNikoflowLoopHook(dir).startLoop(sid, prompt);
    return readNikoflowState(dir, sid) as NikoflowState;
  };

  describe("getCurrentPhase", () => {
    it("is null until a depth is chosen", () => {
      const s = start("do the work");
      expect(getCurrentPhase(s)).toBeNull();
    });
    it("is the first phase once depth is set", () => {
      const s = start("nikoflow:standard do it");
      expect(getCurrentPhase(s)).toBe("interview");
    });
  });

  describe("setNikoflowDepth", () => {
    it("materializes phases and stays mutable at phase 0", () => {
      start("do the work"); // undecided
      expect(setNikoflowDepth(dir, "deep", sid)).toBe(true);
      const s = readNikoflowState(dir, sid)!;
      expect(s.depth).toBe("deep");
      expect(s.phases).toEqual(NIKOFLOW_PHASES.deep);
      expect(s.pbt_enabled).toBe(true);
    });
    it("is immutable once the flow advanced past phase 0", () => {
      start("nikoflow:standard do it");
      advanceNikoflowPhase(dir, sid); // now at index 1 (adr)
      expect(setNikoflowDepth(dir, "tactical", sid)).toBe(false);
      expect(readNikoflowState(dir, sid)!.depth).toBe("standard");
    });
  });

  describe("advanceNikoflowPhase", () => {
    it("walks the phase list and completes at the end", () => {
      start("nikoflow:tactical fix bug"); // phases: interview, execute, verify
      let r = advanceNikoflowPhase(dir, sid);
      expect(r).toEqual({ phase: "execute", complete: false });
      r = advanceNikoflowPhase(dir, sid);
      expect(r).toEqual({ phase: "verify", complete: false });
      r = advanceNikoflowPhase(dir, sid);
      expect(r).toEqual({ phase: null, complete: true });
      expect(isNikoflowComplete(readNikoflowState(dir, sid)!)).toBe(true);
    });
    it("no-ops before a depth is chosen", () => {
      start("do the work");
      expect(advanceNikoflowPhase(dir, sid)).toBeNull();
    });
    it("is idempotent when called again after completion (no index drift)", () => {
      start("nikoflow:tactical fix bug");
      advanceNikoflowPhase(dir, sid);
      advanceNikoflowPhase(dir, sid);
      advanceNikoflowPhase(dir, sid); // now complete
      const idxAtComplete = readNikoflowState(dir, sid)!.phase_index;
      const again = advanceNikoflowPhase(dir, sid);
      expect(again).toEqual({ phase: null, complete: true });
      expect(readNikoflowState(dir, sid)!.phase_index).toBe(idxAtComplete);
    });
  });

  describe("guards", () => {
    it("setNikoflowDepth is rejected after completion", () => {
      start("nikoflow:tactical fix bug");
      advanceNikoflowPhase(dir, sid);
      advanceNikoflowPhase(dir, sid);
      advanceNikoflowPhase(dir, sid); // complete
      expect(setNikoflowDepth(dir, "deep", sid)).toBe(false);
      expect(readNikoflowState(dir, sid)!.depth).toBe("tactical");
    });
    it("isNikoflowComplete is false when depth is undecided", () => {
      const s = start("do the work");
      expect(isNikoflowComplete(s)).toBe(false);
    });
    it("getPhasePrompt falls back for an unknown phase", () => {
      const s = start("nikoflow:standard do it");
      expect(getPhasePrompt("mystery", s)).toContain('phase="mystery"');
    });
  });

  describe("prompts", () => {
    it("depth-selection prompt offers all three tiers + the confirm tag", () => {
      const s = start("do the work");
      const p = getDepthSelectionPrompt(s);
      expect(p).toContain("tactical");
      expect(p).toContain("standard");
      expect(p).toContain("deep");
      expect(p).toContain('<nikoflow-gate phase="depth"');
    });
    it("each phase prompt is distinct and names its gate", () => {
      const s = start("nikoflow:standard do it");
      const interview = getPhasePrompt("interview", s);
      const prd = getPhasePrompt("prd", s);
      expect(interview).not.toBe(prd);
      expect(interview).toContain('phase="interview"');
      expect(prd).toContain("SEAMS_CONFIRMED");
    });
  });
});
