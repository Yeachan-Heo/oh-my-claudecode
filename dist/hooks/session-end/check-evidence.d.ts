/**
 * Check evidence verification for declared mechanical passes (spec #9).
 *
 * When a chain ledger's gateFacts declares `mechanicalChecksPassed: true`,
 * the spawner must leave a check evidence artifact at
 * `.omc/state/runs/evidence/<sessionId>-checks.json`. The enqueuer verifies
 * that artifact before trusting the flag — conservative default: evidence
 * that is absent, malformed, mismatched, or records a failure means the
 * gate grades human.
 */
export interface CheckEvidence {
    sessionId: string;
    checks: Array<{
        name: string;
        passed: boolean;
    }>;
    completedAt: string;
}
/** Evidence artifact path under the omc root: `state/runs/evidence/<sessionId>-checks.json`. */
export declare function checkEvidencePath(stateRoot: string, sessionId: string): string;
/**
 * Verify the check evidence artifact backs a declared mechanical pass.
 * `stateRoot` is the omc root (as returned by getOmcRoot). Returns true only
 * if the file exists, parses, carries the matching sessionId, and every
 * recorded check passed. Any missing file, malformed JSON, failed check, or
 * sessionId mismatch returns false — an unverifiable claim is not a pass.
 */
export declare function verifyCheckEvidence(stateRoot: string, sessionId: string): boolean;
//# sourceMappingURL=check-evidence.d.ts.map