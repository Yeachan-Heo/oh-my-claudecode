import { describe, it, expect } from "vitest";
import {
  normalizeTicketsFile,
  validateTicketDag,
  getNextTicket,
  allTicketsDone,
  type NikoflowTicketsFile,
  type NikoflowTicket,
} from "../index.js";

const mk = (
  id: string,
  blocked_by: string[] = [],
  status: NikoflowTicket["status"] = "todo",
): NikoflowTicket => ({
  id,
  title: `ticket ${id}`,
  acceptance: [`${id} works`],
  blocked_by,
  status,
});

const file = (tickets: NikoflowTicket[]): NikoflowTicketsFile => ({
  version: 1,
  tickets,
});

describe("nikoflow tickets model (TSK-004)", () => {
  describe("normalizeTicketsFile", () => {
    it("returns null for non-tickets input", () => {
      expect(normalizeTicketsFile(null)).toBeNull();
      expect(normalizeTicketsFile({ foo: 1 })).toBeNull();
    });
    it("drops malformed tickets and coerces bad status to todo", () => {
      const n = normalizeTicketsFile({
        tickets: [
          { id: "TSK-001", title: "ok", acceptance: ["a"], blocked_by: [], status: "green" },
          { id: "TSK-002", title: "bad-status", status: "weird" },
          { title: "no id" },
          "garbage",
        ],
      });
      expect(n).not.toBeNull();
      expect(n!.tickets.map((t) => t.id)).toEqual(["TSK-001", "TSK-002"]);
      expect(n!.tickets[1].status).toBe("todo");
      expect(n!.tickets[1].acceptance).toEqual([]);
    });
  });

  describe("validateTicketDag", () => {
    it("accepts a valid linear DAG", () => {
      const v = validateTicketDag(file([mk("A"), mk("B", ["A"]), mk("C", ["B"])]));
      expect(v.ok).toBe(true);
    });
    it("flags an empty ticket set", () => {
      const v = validateTicketDag(file([]));
      expect(v.ok).toBe(false);
      expect(v.errors.join()).toContain("no tickets");
    });
    it("flags a dangling blocked_by reference", () => {
      const v = validateTicketDag(file([mk("A", ["ZZZ"])]));
      expect(v.ok).toBe(false);
      expect(v.errors.join()).toContain("unknown ticket: ZZZ");
    });
    it("flags a self-block", () => {
      const v = validateTicketDag(file([mk("A", ["A"])]));
      expect(v.ok).toBe(false);
      expect(v.errors.join()).toContain("blocked by itself");
    });
    it("flags a duplicate id", () => {
      const v = validateTicketDag(file([mk("A"), mk("A")]));
      expect(v.ok).toBe(false);
      expect(v.errors.join()).toContain("duplicate ticket id: A");
    });
    it("detects a dependency cycle", () => {
      const v = validateTicketDag(file([mk("A", ["C"]), mk("B", ["A"]), mk("C", ["B"])]));
      expect(v.ok).toBe(false);
      expect(v.errors.join()).toContain("dependency cycle");
    });
  });

  describe("getNextTicket", () => {
    it("returns the first unblocked, not-done ticket in document order", () => {
      const f = file([mk("A", [], "done"), mk("B", ["A"]), mk("C")]);
      expect(getNextTicket(f)?.id).toBe("B");
    });
    it("skips tickets whose blockers are not done", () => {
      const f = file([mk("A"), mk("B", ["A"])]);
      // A not done → B blocked → next is A
      expect(getNextTicket(f)?.id).toBe("A");
    });
    it("returns null when everything is done", () => {
      const f = file([mk("A", [], "done"), mk("B", ["A"], "done")]);
      expect(getNextTicket(f)).toBeNull();
      expect(allTicketsDone(f)).toBe(true);
    });
    it("returns null when all remaining tickets are blocked (deadlock is visible)", () => {
      // A blocked by B, B blocked by A would be a cycle; instead all blocked by a not-done external-done? Use: A done, B blocked by C (todo), C blocked by B (todo) — cycle, but getNextTicket just finds none unblocked
      const f = file([mk("B", ["C"]), mk("C", ["B"])]);
      expect(getNextTicket(f)).toBeNull();
    });
  });
});
