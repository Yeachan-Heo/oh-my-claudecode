import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeTickets,
  readTickets,
  markTicketStatus,
  isTicketDeadlock,
  getNextTicket,
  allTicketsDone,
  getExecuteTicketPrompt,
  detectNikoflowGate,
  type NikoflowTicketsFile,
  type NikoflowState,
} from "../index.js";

const state: NikoflowState = {
  active: true,
  iteration: 2,
  started_at: new Date(0).toISOString(),
  prompt: "x",
  depth: "standard",
  phases: ["interview", "adr", "prd", "tickets", "execute", "verify"],
  phase_index: 4,
};

const file = (
  tickets: NikoflowTicketsFile["tickets"],
): NikoflowTicketsFile => ({ version: 1, tickets });

describe("nikoflow execute loop (TSK-005)", () => {
  let dir: string;
  const sid = "sess-exec";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nikoflow-exec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("markTicketStatus persists a status change", () => {
    writeTickets(dir, file([
      { id: "TSK-001", title: "a", acceptance: ["a"], blocked_by: [], status: "todo" },
    ]), sid);
    expect(markTicketStatus(dir, "TSK-001", "done", sid)).toBe(true);
    expect(readTickets(dir, sid)!.tickets[0].status).toBe("done");
  });

  it("markTicketStatus returns false for an unknown ticket", () => {
    writeTickets(dir, file([
      { id: "TSK-001", title: "a", acceptance: [], blocked_by: [], status: "todo" },
    ]), sid);
    expect(markTicketStatus(dir, "TSK-999", "done", sid)).toBe(false);
  });

  it("isTicketDeadlock distinguishes done / startable / deadlocked", () => {
    expect(isTicketDeadlock(file([
      { id: "A", title: "a", acceptance: [], blocked_by: [], status: "done" },
    ]))).toBe(false); // all done
    expect(isTicketDeadlock(file([
      { id: "A", title: "a", acceptance: [], blocked_by: [], status: "todo" },
    ]))).toBe(false); // A startable
    expect(isTicketDeadlock(file([
      { id: "A", title: "a", acceptance: [], blocked_by: ["B"], status: "todo" },
      { id: "B", title: "b", acceptance: [], blocked_by: ["A"], status: "todo" },
    ]))).toBe(true); // mutual block
  });

  it("getNextTicket advances as tickets complete", () => {
    writeTickets(dir, file([
      { id: "TSK-001", title: "a", acceptance: [], blocked_by: [], status: "todo" },
      { id: "TSK-002", title: "b", acceptance: [], blocked_by: ["TSK-001"], status: "todo" },
    ]), sid);
    expect(getNextTicket(readTickets(dir, sid)!)!.id).toBe("TSK-001");
    markTicketStatus(dir, "TSK-001", "done", sid);
    expect(getNextTicket(readTickets(dir, sid)!)!.id).toBe("TSK-002");
    markTicketStatus(dir, "TSK-002", "done", sid);
    expect(allTicketsDone(readTickets(dir, sid)!)).toBe(true);
  });

  describe("per-ticket gate", () => {
    const RID = "aaaa-bbbb-cccc";
    it("matches a ticket-scoped TICKET_DONE tag with the right id + rid", () => {
      const t = `<nikoflow-gate phase="execute:TSK-001" request-id="${RID}">TICKET_DONE</nikoflow-gate>`;
      expect(
        detectNikoflowGate(t, { phase: "execute:TSK-001", requestId: RID, expectedPayloads: ["TICKET_DONE"] }).matched,
      ).toBe(true);
    });
    it("does not match a different ticket's gate", () => {
      const t = `<nikoflow-gate phase="execute:TSK-002" request-id="${RID}">TICKET_DONE</nikoflow-gate>`;
      expect(
        detectNikoflowGate(t, { phase: "execute:TSK-001", requestId: RID, expectedPayloads: ["TICKET_DONE"] }).matched,
      ).toBe(false);
    });
    it("rejects a wrong payload", () => {
      const t = `<nikoflow-gate phase="execute:TSK-001" request-id="${RID}">DONE</nikoflow-gate>`;
      expect(
        detectNikoflowGate(t, { phase: "execute:TSK-001", requestId: RID, expectedPayloads: ["TICKET_DONE"] }).matched,
      ).toBe(false);
    });
  });

  describe("getExecuteTicketPrompt", () => {
    it("includes the ticket id, acceptance, and the ticket-scoped gate tag", () => {
      const p = getExecuteTicketPrompt(
        { id: "TSK-003", title: "parse", acceptance: ["handles empty input"] },
        state,
        "rid-1",
      );
      expect(p).toContain("TSK-003");
      expect(p).toContain("handles empty input");
      expect(p).toContain('phase="execute:TSK-003"');
      expect(p).toContain('request-id="rid-1"');
    });
    it("renders the framework-specific PBT line when the obligation is ready", () => {
      const p = getExecuteTicketPrompt(
        { id: "TSK-003", title: "parse", acceptance: ["a"] },
        state,
        "rid-1",
        { required: true, status: "ready", framework: "fast-check", reason: "use fast-check" },
      );
      expect(p.toLowerCase()).toContain("property");
      expect(p).toContain("fast-check");
    });
    it("tells the model to ask before adding a missing PBT lib (needs-lib)", () => {
      const p = getExecuteTicketPrompt(
        { id: "TSK-003", title: "parse", acceptance: ["a"] },
        state,
        "rid-1",
        { required: true, status: "needs-lib", framework: "hypothesis", reason: "not installed" },
      );
      expect(p.toLowerCase()).toContain("ask");
      expect(p).toContain("hypothesis");
    });
    it("omits the PBT line when the obligation is waived / absent", () => {
      const p = getExecuteTicketPrompt(
        { id: "TSK-004", title: "x", acceptance: ["a"] },
        state,
        "rid-2",
        { required: false, status: "waived", reason: "not deep tier" },
      );
      expect(p.toLowerCase()).not.toContain("property");
    });
  });
});
