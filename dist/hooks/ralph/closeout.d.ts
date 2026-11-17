/**
 * Ralph terminal closeout record.
 *
 * The skill's Step 7.5 deslop pass and Step 8 closeout are prose: nothing
 * failed when an agent skipped them and reported success. This module backs
 * an explicit, revision-bound record that `omc ralph verify` requires once
 * every PRD story is complete.
 *
 * It records the closeout step, not the deslop work itself — an agent can
 * still lie. What it removes is silence: a completed run now has to state
 * whether the pass ran, and a stale record cannot be reused after the story
 * criteria change.
 */
export declare const RALPH_CLOSEOUT_FILENAME = "ralph-closeout.json";
export declare const DESLOP_STATUSES: readonly ["completed", "skipped"];
export type DeslopStatus = (typeof DESLOP_STATUSES)[number];
export interface RalphCloseout {
    version: 1;
    sessionId: string;
    deslop: DeslopStatus;
    /** Criteria revision the record was written against; a later criteria edit invalidates it. */
    criteriaRevision: string;
    recordedAt: string;
}
export declare function isDeslopStatus(value: unknown): value is DeslopStatus;
export declare function closeoutPath(stateRoot: string, sessionId: string): string;
export declare function readCloseout(path: string): RalphCloseout | null;
export declare function writeCloseout(path: string, record: Omit<RalphCloseout, 'version' | 'recordedAt'>, now?: Date): boolean;
/**
 * True when the record covers the criteria revision that is complete now.
 * A record written before a criteria amendment must not satisfy the gate.
 */
export declare function isCloseoutSatisfied(record: RalphCloseout | null, criteriaRevision: string): boolean;
//# sourceMappingURL=closeout.d.ts.map