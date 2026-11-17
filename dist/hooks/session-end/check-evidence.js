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
import * as fs from 'fs';
import { join } from 'path';
import { validateSessionId } from '../../lib/worktree-paths.js';
/** Evidence artifact path under the omc root: `state/runs/evidence/<sessionId>-checks.json`. */
export function checkEvidencePath(stateRoot, sessionId) {
    return join(stateRoot, 'state', 'runs', 'evidence', `${sessionId}-checks.json`);
}
/**
 * Verify the check evidence artifact backs a declared mechanical pass.
 * `stateRoot` is the omc root (as returned by getOmcRoot). Returns true only
 * if the file exists, parses, carries the matching sessionId, and every
 * recorded check passed. Any missing file, malformed JSON, failed check, or
 * sessionId mismatch returns false — an unverifiable claim is not a pass.
 */
export function verifyCheckEvidence(stateRoot, sessionId) {
    try {
        validateSessionId(sessionId);
    }
    catch {
        return false;
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(checkEvidencePath(stateRoot, sessionId), 'utf8'));
    }
    catch {
        return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return false;
    const evidence = parsed;
    if (evidence.sessionId !== sessionId)
        return false;
    if (!Array.isArray(evidence.checks))
        return false;
    return evidence.checks.every((check) => {
        if (!check || typeof check !== 'object')
            return false;
        return check.passed === true;
    });
}
//# sourceMappingURL=check-evidence.js.map