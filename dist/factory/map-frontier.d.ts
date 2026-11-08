/**
 * Wayfinder map frontier enumeration (spec #51, ticket T-A).
 *
 * The single decision surface of map ingestion: given tracker issue records,
 * answer "which tickets are on this map's frontier, in what order, and which
 * may a headless ralph claim?". Pure — no IO, no tracker client. The ingestion
 * module (T-B) feeds it normalized records; every downstream action (claim,
 * routing, story materialization) reads its verdict.
 *
 * Semantics fixed by map #46's decisions (research #47, design #48):
 * - Children: native parent, else the body's Parent section naming the map.
 * - Filters: OPEN only; drop if any blocker (native or body-named) is OPEN,
 *   transitively through closed; drop if assigned.
 * - Order: ascending ticket number, overridable by an Order line in the body.
 * - Gate class: research is auto-executable; a task ticket is auto-executable
 *   only with the AFK opt-in label; grilling, prototype, bare task, and
 *   unknown types are human-gated (the safe direction is the default).
 * - A malformed blocking edge degrades safe: the ticket is never offered as
 *   auto-executable.
 */
export declare const WAYFINDER_TASK_AFK_LABEL = "wayfinder:task:afk";
export declare const WAYFINDER_AWAITING_HUMAN_LABEL = "wayfinder:awaiting-human";
export type TicketState = 'OPEN' | 'CLOSED';
export type WayfinderTicketType = 'research' | 'prototype' | 'grilling' | 'task' | 'other';
export type GateClass = 'auto' | 'human';
export interface TicketRecord {
    number: number;
    state: TicketState;
    /** Raw label names on the ticket (including any `wayfinder:<type>` label). */
    labels: string[];
    /** Number of assignees; non-zero means claimed. */
    assignees: number;
    /** Raw issue body (the tolerantly-parsed source of edges, order, criteria). */
    body: string;
    /** Issue title, when the tracker read carried it (story materialization). */
    title?: string;
    /** Native parent issue number, when the tracker relation is set. */
    nativeParent?: number | null;
    /** Native blocker issue numbers, when the tracker relation is set. */
    nativeBlockedBy?: number[];
}
export interface FrontierTicket {
    number: number;
    type: WayfinderTicketType;
    gateClass: GateClass;
    /** True when the gated ticket already carries the awaiting-human label. */
    awaitingHuman: boolean;
    /** Effective ordering key (Order override or ticket number). */
    order: number;
    /** True when the body carries an acceptance-criteria section. */
    hasCriteria: boolean;
    /** True when a blocking edge on this ticket could not be parsed. */
    malformedEdge: boolean;
}
export interface Frontier {
    mapNumber: number;
    /** Auto-executable frontier, ordered. */
    auto: FrontierTicket[];
    /** Human-gated frontier, ordered. */
    human: FrontierTicket[];
    /** Children excluded because a blocking edge was unparseable (safe direction). */
    malformedEdges: number[];
}
/** Gate class per map #46's decision: only research and explicitly-AFK tasks are auto; everything else human. */
export declare function gateClassFor(type: WayfinderTicketType, labels: string[]): GateClass;
/**
 * Enumerate a map's frontier from issue records. Records may include issues
 * beyond the children (referenced blockers) so blocker states resolve; a
 * blocker whose state is unknown counts as OPEN (safe: blocked pending
 * verification).
 */
export declare function enumerateFrontier(mapNumber: number, records: readonly TicketRecord[]): Frontier;
//# sourceMappingURL=map-frontier.d.ts.map