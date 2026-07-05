/**
 * Nikoflow tickets model.
 *
 * The Ticketization phase decomposes the PRD into atomic vertical-slice tickets
 * (TSK-001…) with acceptance criteria + blocked-by dependencies. This module
 * owns the tickets.json shape, normalization (reject junk), DAG validation
 * (cycles + dangling refs), and deterministic next-ticket selection consumed by
 * the Execute phase (TSK-005).
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { atomicWriteJsonSync } from "../../lib/atomic-write.js";
import {
  resolveSessionStatePath,
  ensureSessionStateDir,
  getOmcRoot,
} from "../../lib/worktree-paths.js";
import { join } from "path";

export type TicketStatus = "todo" | "red" | "green" | "review" | "done";
const TICKET_STATUSES: readonly TicketStatus[] = [
  "todo",
  "red",
  "green",
  "review",
  "done",
];

export interface NikoflowTicket {
  /** Stable id, e.g. "TSK-001". */
  id: string;
  /** Optional originating PRD story id. */
  story_id?: string;
  title: string;
  /** Acceptance criteria (checkbox lines). */
  acceptance: string[];
  /** Ids of tickets that must be done before this one can start. */
  blocked_by: string[];
  /** How to independently verify this slice. */
  self_verify?: string;
  /** Whether this ticket owes property-based tests (deep tier). */
  pbt_required?: boolean;
  status: TicketStatus;
  /** Evidence collected during execution/review. */
  evidence?: Record<string, unknown>;
}

export interface NikoflowTicketsFile {
  version: 1;
  tickets: NikoflowTicket[];
}

export interface DagValidation {
  ok: boolean;
  /** Human-readable reasons the DAG is invalid. */
  errors: string[];
}

const TICKETS_STATE_KEY = "nikoflow-tickets";

function ticketsPath(directory: string, sessionId?: string): string {
  if (sessionId) {
    return resolveSessionStatePath(TICKETS_STATE_KEY, sessionId, directory);
  }
  return join(getOmcRoot(directory), `${TICKETS_STATE_KEY}.json`);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Normalize an untrusted parsed object into a tickets file, dropping anything
 * that does not fit the shape. Returns null if it is not a tickets file at all.
 */
export function normalizeTicketsFile(raw: unknown): NikoflowTicketsFile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.tickets)) return null;

  const tickets: NikoflowTicket[] = [];
  for (const t of obj.tickets) {
    if (!t || typeof t !== "object") continue;
    const rec = t as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (typeof rec.title !== "string") continue;

    const status =
      typeof rec.status === "string" &&
      (TICKET_STATUSES as readonly string[]).includes(rec.status)
        ? (rec.status as TicketStatus)
        : "todo";

    tickets.push({
      id: rec.id,
      ...(typeof rec.story_id === "string" ? { story_id: rec.story_id } : {}),
      title: rec.title,
      acceptance: asStringArray(rec.acceptance),
      blocked_by: asStringArray(rec.blocked_by),
      ...(typeof rec.self_verify === "string"
        ? { self_verify: rec.self_verify }
        : {}),
      ...(typeof rec.pbt_required === "boolean"
        ? { pbt_required: rec.pbt_required }
        : {}),
      status,
      ...(rec.evidence && typeof rec.evidence === "object"
        ? { evidence: rec.evidence as Record<string, unknown> }
        : {}),
    });
  }

  return { version: 1, tickets };
}

/**
 * Lint the RAW parsed tickets object for shape problems that normalization
 * would silently launder into a valid-but-wrong graph (e.g. `blocked_by` given
 * as a bare string, a mistyped status, a non-string acceptance entry). The
 * tickets gate surfaces these instead of quietly dropping data.
 */
export function lintTicketsRaw(raw: unknown): string[] {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") {
    return ["tickets.json is not an object"];
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.tickets)) {
    return ["tickets.json has no 'tickets' array"];
  }
  obj.tickets.forEach((t, i) => {
    const label = `ticket #${i + 1}`;
    if (!t || typeof t !== "object") {
      warnings.push(`${label}: not an object`);
      return;
    }
    const rec = t as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : label;
    if (typeof rec.id !== "string" || !rec.id) warnings.push(`${label}: missing string id`);
    if (typeof rec.title !== "string") warnings.push(`${id}: missing string title`);
    if ("blocked_by" in rec && !Array.isArray(rec.blocked_by)) {
      warnings.push(`${id}: blocked_by must be an array of ids, not ${typeof rec.blocked_by}`);
    }
    if ("acceptance" in rec && !Array.isArray(rec.acceptance)) {
      warnings.push(`${id}: acceptance must be an array`);
    }
    if (
      "status" in rec &&
      !(typeof rec.status === "string" &&
        (TICKET_STATUSES as readonly string[]).includes(rec.status))
    ) {
      warnings.push(`${id}: invalid status ${JSON.stringify(rec.status)}`);
    }
  });
  return warnings;
}

/** Read + lint the raw tickets file (before normalization). */
export function lintTicketsFile(directory: string, sessionId?: string): string[] {
  const path = ticketsPath(directory, sessionId);
  if (!existsSync(path)) return ["tickets.json not found"];
  try {
    return lintTicketsRaw(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return ["tickets.json is not valid JSON"];
  }
}

export function readTickets(
  directory: string,
  sessionId?: string,
): NikoflowTicketsFile | null {
  const path = ticketsPath(directory, sessionId);
  if (!existsSync(path)) return null;
  try {
    return normalizeTicketsFile(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

export function writeTickets(
  directory: string,
  file: NikoflowTicketsFile,
  sessionId?: string,
): boolean {
  const path = ticketsPath(directory, sessionId);
  try {
    if (sessionId) {
      ensureSessionStateDir(sessionId, directory);
    }
    // Atomic write (temp + rename) so a hook killed mid-write can't leave a torn
    // tickets.json that fails the next lint/DAG gate (Fable QA R5).
    atomicWriteJsonSync(path, file);
    return true;
  } catch {
    return false;
  }
}

export function clearTickets(directory: string, sessionId?: string): boolean {
  const path = ticketsPath(directory, sessionId);
  if (!existsSync(path)) return true;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the ticket dependency graph: every blocked_by id must exist, ids must
 * be unique, and there must be no dependency cycle. Returns all problems found.
 */
export function validateTicketDag(file: NikoflowTicketsFile): DagValidation {
  const errors: string[] = [];
  const ids = new Set<string>();
  const dup = new Set<string>();
  for (const t of file.tickets) {
    if (ids.has(t.id)) dup.add(t.id);
    ids.add(t.id);
  }
  for (const d of dup) errors.push(`duplicate ticket id: ${d}`);

  if (file.tickets.length === 0) {
    errors.push("no tickets defined");
  }

  const byId = new Map(file.tickets.map((t) => [t.id, t]));
  for (const t of file.tickets) {
    for (const dep of t.blocked_by) {
      if (dep === t.id) errors.push(`${t.id} is blocked by itself`);
      else if (!byId.has(dep)) errors.push(`${t.id} blocked_by unknown ticket: ${dep}`);
    }
  }

  // Cycle detection via DFS (white/grey/black colouring).
  const colour = new Map<string, 0 | 1 | 2>(); // 0=unseen,1=in-stack,2=done
  const cyclePath: string[] = [];
  let cycleFound: string | null = null;

  const visit = (id: string): void => {
    if (cycleFound) return;
    colour.set(id, 1);
    cyclePath.push(id);
    const node = byId.get(id);
    for (const dep of node?.blocked_by ?? []) {
      if (dep === id) continue; // self-block already reported above
      if (!byId.has(dep)) continue; // dangling handled above
      const c = colour.get(dep) ?? 0;
      if (c === 1) {
        cycleFound = dep;
        break;
      }
      if (c === 0) visit(dep);
      if (cycleFound) break;
    }
    if (!cycleFound) {
      colour.set(id, 2);
      cyclePath.pop();
    }
  };

  for (const t of file.tickets) {
    if ((colour.get(t.id) ?? 0) === 0) visit(t.id);
    if (cycleFound) break;
  }
  if (cycleFound) {
    const start = cyclePath.indexOf(cycleFound);
    const loop = [...cyclePath.slice(start), cycleFound].join(" → ");
    errors.push(`dependency cycle: ${loop}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The next ticket to work: the first (document-order) ticket that is not done
 * and whose every blocker is done. Returns null when all are done or all
 * remaining are blocked.
 */
export function getNextTicket(
  file: NikoflowTicketsFile,
): NikoflowTicket | null {
  const byId = new Map(file.tickets.map((t) => [t.id, t]));
  for (const t of file.tickets) {
    if (t.status === "done") continue;
    const blockersDone = t.blocked_by.every(
      (d) => byId.get(d)?.status === "done",
    );
    if (blockersDone) return t;
  }
  return null;
}

export function allTicketsDone(file: NikoflowTicketsFile): boolean {
  return file.tickets.length > 0 && file.tickets.every((t) => t.status === "done");
}

/**
 * Set a ticket's status (read-modify-write). Optionally merge evidence.
 * Returns false if the file or ticket is missing.
 */
export function markTicketStatus(
  directory: string,
  ticketId: string,
  status: TicketStatus,
  sessionId?: string,
  evidence?: Record<string, unknown>,
): boolean {
  const file = readTickets(directory, sessionId);
  if (!file) return false;
  const ticket = file.tickets.find((t) => t.id === ticketId);
  if (!ticket) return false;
  ticket.status = status;
  if (evidence) {
    ticket.evidence = { ...(ticket.evidence ?? {}), ...evidence };
  }
  return writeTickets(directory, file, sessionId);
}

/**
 * Execute-phase health: is the ticket graph currently deadlocked — i.e. not all
 * done, yet no ticket is startable (every remaining ticket is blocked). This is
 * distinct from "all done" and must be surfaced as an error, not completion.
 */
export function isTicketDeadlock(file: NikoflowTicketsFile): boolean {
  return !allTicketsDone(file) && getNextTicket(file) === null;
}
