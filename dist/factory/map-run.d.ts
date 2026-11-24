/**
 * Map-driven run orchestration (spec #51, ticket #55): the claimed frontier
 * tickets become PRD stories, a launch gate refuses to start while drafted
 * criteria await human acceptance, and finalize closes each verified source
 * ticket with evidence plus a one-line pointer on the map.
 *
 * Tracker IO stays in map-ingest; this module composes it with the ralph PRD
 * and the loop launcher's argv.
 */
import { type ActionOutcome, type CommentRunner, type GhRunner, type MapPlan, type MapRef } from './map-ingest.js';
import { type PRD } from '../hooks/ralph/prd.js';
import type { TicketRecord } from './map-frontier.js';
/** The checklist items of a ticket's Acceptance criteria section. */
export declare function criteriaItems(body: string): string[];
/** The first meaningful line of a ticket's Question section (falls back to the body). */
export declare function questionOf(body: string, fallback: string): string;
export interface MapStory {
    ticket: number;
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
}
/** Pure: the plan's ingest-with-criteria auto tickets, in order, as story drafts. */
export declare function storiesFromPlan(plan: MapPlan, records: readonly TicketRecord[]): MapStory[];
export interface LaunchGate {
    ok: boolean;
    /** Drafted tickets still awaiting human acceptance of their criteria. */
    blocked: Array<{
        ticket: number;
        reason: string;
    }>;
}
/**
 * The launch gate: every drafted-criteria ticket must show an acceptance
 * criteria section in its body (the human edited and accepted) before any
 * loop may start.
 */
export declare function launchGate(outcomes: readonly ActionOutcome[], records: readonly TicketRecord[]): LaunchGate;
export interface ComposeResult {
    written: boolean;
    stories: MapStory[];
    prdPath: string | null;
    error?: string;
}
/** Write the session-scoped PRD whose stories come from the claimed map tickets. */
export declare function composeMapPrd(directory: string, sessionId: string, plan: MapPlan, records: readonly TicketRecord[], options?: {
    feedbackCommands?: string[];
}): ComposeResult;
export interface MapRunSidecar {
    map: MapRef;
    /** Ticket -> story id mapping; survives notes rewrites (the PRD's story notes
     * are mutable, and any reviewer note replaces them). */
    stories: Array<{
        ticket: number;
        id: string;
    }>;
}
/** Read the compose-time ticket↔story mapping; null when absent. */
export declare function readMapRunSidecar(directory: string, sessionId: string): MapRunSidecar | null;
/** The task prompt a launched map run receives. */
export declare function mapRunTaskPrompt(plan: MapPlan, stories: readonly MapStory[]): string;
export interface FinalizeOptions {
    gh?: GhRunner;
    comment?: CommentRunner;
}
/**
 * Write-back: every ingested story that passed AND carries reviewer sign-off
 * closes its source ticket with an evidence comment; the map's
 * Decisions-so-far gains one pointer line. Unverified stories are reported,
 * never closed.
 */
export declare function finalizeMapRun(ref: MapRef, stories: readonly MapStory[], prd: PRD, options?: FinalizeOptions): ActionOutcome[];
//# sourceMappingURL=map-run.d.ts.map