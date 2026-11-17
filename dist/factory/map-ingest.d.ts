/**
 * Wayfinder map ingestion (spec #51, ticket T-B).
 *
 * The single module that talks to the tracker for map-driven ralph runs. Every
 * read funnels through here; the decision logic lives in the pure enumerator
 * (map-frontier). A future non-GitHub tracker would replace this module and
 * nothing else.
 *
 * Reads use the `gh` CLI — the same mechanism the factory chain's tracker
 * writeback already uses — and are injectable so the module is testable without
 * a network.
 */
import { type Frontier, type TicketRecord } from './map-frontier.js';
export interface GhRunner {
    (args: string[]): {
        status: number | null;
        stdout: string;
        stderr: string;
    };
}
export declare const defaultGhRunner: GhRunner;
export interface MapRef {
    repo: string;
    number: number;
}
/** Parse `owner/repo#46` (repo optional — defaults to the current repository's origin). */
export declare function parseMapRef(raw: string, fallbackRepo?: string): MapRef | null;
/**
 * Load every record the frontier computation needs: the map's children
 * candidates (found by body search — the relation that works on live maps),
 * plus any issue referenced as a blocker so its state resolves. An unreadable
 * issue is skipped; the enumerator treats an unknown blocker as open (safe).
 */
export declare function loadMapRecords(ref: MapRef, gh?: GhRunner): TicketRecord[];
export interface PlannedTicket {
    number: number;
    gateClass: 'auto' | 'human';
    /** auto only: ingest with these criteria, or draft first and stop for acceptance. */
    disposition: 'ingest-with-criteria' | 'draft-criteria-then-stop';
    awaitingHuman: boolean;
    malformedEdge: boolean;
}
export interface MapPlan {
    map: MapRef;
    planned: PlannedTicket[];
    frontier: Frontier;
}
/** The plan a dry run prints and a real run acts on: the enumerator's verdict, classified. */
export declare function planFromMap(ref: MapRef, records: readonly TicketRecord[]): MapPlan;
export declare function renderMapPlan(plan: MapPlan): string;
export interface Provenance {
    /** Session id stamped into the provenance comment (the launcher's uuid). */
    sessionId: string;
    /** AFK or interactive; recorded so a crashed unattended claim is visible. */
    mode: 'afk' | 'hitl';
    /** ISO 8601 claim time. */
    at: string;
}
export interface ActionOutcome {
    ticket: number;
    action: 'claimed' | 'drafted-then-stopped' | 'routed-to-human' | 'skipped';
    detail?: string;
}
/** Pure: the criteria draft a human edits to unblock a criteria-less ticket. */
export declare function draftCriteriaFromQuestion(body: string): string[];
export declare function renderProvenance(ref: MapRef, ticket: number, provenance: Provenance): string;
export declare function renderRoutingComment(ref: MapRef, ticket: number, awaitingHuman: boolean): string;
/** Comment runner: returns the gh exit status. Injectable for tests. */
export type CommentRunner = (ref: MapRef, ticket: number, body: string) => number | null;
export declare const defaultCommentRunner: CommentRunner;
export interface ExecuteActionsOptions {
    provenance: Provenance;
    gh?: GhRunner;
    /** Comment runner (gh by default); injected in tests. */
    comment?: CommentRunner;
}
export declare function executePlanActions(plan: MapPlan, options: ExecuteActionsOptions): ActionOutcome[];
export declare function renderActionOutcomes(outcomes: readonly ActionOutcome[]): string;
//# sourceMappingURL=map-ingest.d.ts.map