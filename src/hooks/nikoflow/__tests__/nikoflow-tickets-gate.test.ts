import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  lintTicketsRaw,
  writeTickets,
  readTickets,
  validateTicketDag,
  type NikoflowTicketsFile,
} from "../index.js";

/**
 * These cover the artifact-validation logic behind the tickets-gate precondition
 * (nikoflowGatePrecondition in persistent-mode): a gate must not advance while
 * tickets.json is missing, mis-shaped, or an invalid DAG. The end-to-end Stop-hook
 * wiring (rotation on precondition-fail) is exercised by the TSK-009 dogfood, where
 * mode-state paths resolve against a real git worktree.
 */
describe("nikoflow tickets-gate precondition logic (TSK-004)", () => {
  describe("lint surfaces laundered shape errors that normalization would hide", () => {
    it("flags blocked_by given as a bare string", () => {
      const w = lintTicketsRaw({
        tickets: [{ id: "TSK-001", title: "a", acceptance: ["a"], blocked_by: "TSK-000", status: "todo" }],
      });
      expect(w.join()).toContain("blocked_by must be an array");
    });
    it("flags a mistyped status", () => {
      const w = lintTicketsRaw({
        tickets: [{ id: "TSK-001", title: "a", blocked_by: [], status: "Done" }],
      });
      expect(w.join()).toContain("invalid status");
    });
    it("flags a non-object / missing tickets array", () => {
      expect(lintTicketsRaw(null).join()).toContain("not an object");
      expect(lintTicketsRaw({ foo: 1 }).join()).toContain("no 'tickets' array");
    });
    it("passes a clean file", () => {
      const w = lintTicketsRaw({
        tickets: [{ id: "TSK-001", title: "a", acceptance: ["a"], blocked_by: [], status: "todo" }],
      });
      expect(w).toEqual([]);
    });
  });

  describe("artifact round-trip + DAG validation via the real state path", () => {
    let dir: string;
    const sid = "sess-tg";
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "nikoflow-tg-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("a written invalid (cyclic) tickets file reads back and fails the DAG gate", () => {
      const cyclic: NikoflowTicketsFile = {
        version: 1,
        tickets: [
          { id: "A", title: "a", acceptance: [], blocked_by: ["B"], status: "todo" },
          { id: "B", title: "b", acceptance: [], blocked_by: ["A"], status: "todo" },
        ],
      };
      expect(writeTickets(dir, cyclic, sid)).toBe(true);
      const read = readTickets(dir, sid);
      expect(read).not.toBeNull();
      expect(validateTicketDag(read!).ok).toBe(false);
    });

    it("a valid tickets file passes the DAG gate", () => {
      const valid: NikoflowTicketsFile = {
        version: 1,
        tickets: [
          { id: "TSK-001", title: "a", acceptance: ["a"], blocked_by: [], status: "todo" },
          { id: "TSK-002", title: "b", acceptance: ["b"], blocked_by: ["TSK-001"], status: "todo" },
        ],
      };
      writeTickets(dir, valid, sid);
      expect(validateTicketDag(readTickets(dir, sid)!).ok).toBe(true);
    });

    it("a missing tickets file reads as null (gate would block)", () => {
      expect(readTickets(dir, sid)).toBeNull();
    });
  });
});
