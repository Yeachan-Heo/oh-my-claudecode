/**
 * Generated closure inventory for alias retirement — Issue #3711.
 *
 * Enumerates the generated/duplicate projection paths that become deletable
 * ONLY after their owning alias is proven `eligible` by the verifier. This
 * module never deletes files; it reports what would be deletable under a
 * proven-eligible receipt and asserts that no deletable file is removed
 * while the receipt is `extended`.
 *
 * Deletion itself MUST be performed in a dedicated, separately reviewed PR
 * that attaches the eligibility receipt as evidence.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Build a closure report from verifier receipts and a filesystem snapshot.
 *
 * `receipts` must be the output of `verifyAllAliases`.
 * `exists` is injectable for testing (defaults to fs.existsSync against `cwd`).
 */
export function buildClosureReport(receipts, options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const exists = options.exists ?? ((p) => existsSync(join(cwd, p)));
    const byAlias = new Map(receipts.map((r) => [r.alias.toLowerCase(), r]));
    const entries = receipts.flatMap((r) => r.generatedArtifacts.map((p) => {
        const receipt = byAlias.get(r.alias.toLowerCase());
        const deletableNow = receipt.verdict === 'eligible';
        return {
            path: p,
            alias: r.alias,
            canonical: r.canonical,
            deletableOnlyAfterEligible: true,
            exists: exists(p),
            deletableNow,
            blockedBy: deletableNow ? [] : receipt.blockers,
        };
    }));
    const allDeletable = entries.length === 0 || entries.every((e) => e.deletableNow);
    const noPrematureDeletion = 
    // "Premature deletion" would mean a path listed as deletable-only-after-eligible
    // is already missing while its owner is still extended. In the current machine
    // we cannot distinguish "never existed" from "prematurely deleted", so we use
    // a conservative signal: if any owned path is missing while still extended,
    // we report false and let the caller decide whether the file was expected.
    // For the additive #3711 surface we require that every listed artifact that
    // was present at introduction still exists while the alias is extended.
    // Tests inject `exists` to assert the invariant without relying on repo layout.
    entries.filter((e) => !e.deletableNow && !e.exists).length === 0
        ? true
        : false;
    // More useful integrity: if any receipt is extended, no file in that group
    // should be considered deletable.
    return {
        evaluatedAt: new Date().toISOString(),
        currentVersion: receipts[0]?.currentVersion ?? 'unknown',
        entries,
        allDeletable,
        noPrematureDeletion,
    };
}
export function summarizeClosureForEvidence(report) {
    const lines = [];
    lines.push(`alias-retirement generated closure report: version=${report.currentVersion} at=${report.evaluatedAt}`);
    lines.push(`allDeletable=${report.allDeletable} noPrematureDeletion=${report.noPrematureDeletion}`);
    for (const e of report.entries) {
        const status = e.deletableNow ? 'deletable-after-eligibility' : `retained (blocked: ${e.blockedBy.slice(0, 2).join(' | ')})`;
        const existMark = e.exists ? 'exists' : 'missing';
        lines.push(`- ${e.path} (alias ${e.alias} -> ${e.canonical}): ${existMark}, ${status}`);
    }
    if (report.entries.length === 0) {
        lines.push('(no alias-owned generated artifacts in current registry)');
    }
    return lines.join('\n');
}
//# sourceMappingURL=closure.js.map