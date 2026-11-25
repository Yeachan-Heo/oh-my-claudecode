/**
 * Runs for the tests of `omc graph gc` and `omc graph status`, written the way the runtime writes them: the descriptor
 * is sealed, every journal record comes out of the scheduler (so it carries its request fingerprint) and is signed
 * with the journal fingerprint, and the snapshot is the envelope the runner saves after each record. They are built
 * synchronously and without a process, so a test can make many of them. A forged or damaged file is made by editing
 * what this module wrote.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sealGraphDescriptor } from "../../descriptor.js";
import { applyHumanApproval, applyNodeResult, beginActivationAttempt, initializeGraphProjection } from "../../scheduler.js";
import { computeJournalFingerprint } from "../../runtime/journal.js";
function commandNode(id) {
    return {
        id,
        kind: "command",
        title: `Step ${id}`,
        timeout_ms: 60_000,
        max_attempts: 1,
        effect_policy: { policy: "side_effect_free" },
        command: "node -e 0",
    };
}
function descriptorFor(runId, kind) {
    const gated = kind === "approval" || kind === "denied";
    return sealGraphDescriptor({
        descriptor_version: 1,
        run_id: runId,
        revision_id: `rev-${runId}`,
        goal: "gc fixture",
        nodes: gated
            ? [commandNode("step-1"), { id: "gate", kind: "human-approval", title: "Approve", prompt: "Approve?" }, commandNode("step-2")]
            : [commandNode("step-1"), commandNode("step-2")],
        edges: gated
            ? [
                { id: "e-1-gate", kind: "fixed", from: "step-1", to: "gate" },
                { id: "e-gate-2", kind: "fixed", from: "gate", to: "step-2" },
            ]
            : [{ id: "e-1-2", kind: "fixed", from: "step-1", to: "step-2" }],
        entry_node_ids: ["step-1"],
        concurrency_limit: 1,
        terminal_verification_node_id: "step-2",
    });
}
const EVIDENCE = [{ kind: "command", ref: "node -e 0" }];
/** Writes a run of the given kind under `root/<runId>` and returns what was written. `epoch` is the writer epoch of the records. */
export function writeRealRun(root, runId, kind, epoch = 1) {
    const sealed = descriptorFor(runId, kind);
    let projection = initializeGraphProjection(sealed, { "step-1": "step-1-act0" });
    const records = [];
    const append = (transition) => {
        const record = { seq: records.length, epoch, descriptor_hash: sealed.descriptor_hash, transition };
        records.push({ ...record, journal_fingerprint: computeJournalFingerprint(record) });
    };
    const runStep = (activationId, outcome, nextEdge) => {
        const attemptId = `${activationId}-t1`;
        const running = beginActivationAttempt(sealed, projection, { activation_id: activationId, attempt_id: attemptId });
        const applied = applyNodeResult(sealed, running, {
            activation_id: activationId,
            transition_id: `${activationId}-tx1`,
            result: { outcome, attempt_id: attemptId, output_summary: outcome, evidence_refs: EVIDENCE },
            identities: nextEdge === undefined || outcome === "failed" ? undefined : { next_activation_ids: { [nextEdge.id]: nextEdge.next } },
        });
        projection = applied.projection;
        append(applied.transition);
    };
    if (kind === "failed")
        runStep("step-1-act0", "failed");
    if (kind === "succeeded" || kind === "ready")
        runStep("step-1-act0", "succeeded", { id: "e-1-2", next: "step-2-act0" });
    if (kind === "succeeded")
        runStep("step-2-act0", "succeeded");
    if (kind === "approval" || kind === "denied") {
        runStep("step-1-act0", "succeeded", { id: "e-1-gate", next: "gate-act0" });
        const decision = kind === "approval" ? undefined : "denied";
        if (decision !== undefined) {
            const applied = applyHumanApproval(sealed, projection, {
                activation_id: "gate-act0",
                transition_id: "gate-act0-tx0",
                decision: { decision, evidence_refs: [{ kind: "human", ref: "operator" }] },
            });
            projection = applied.projection;
            append(applied.transition);
        }
    }
    const envelope = {
        schema_version: 1,
        descriptor_hash: sealed.descriptor_hash,
        run_id: runId,
        revision_id: sealed.revision_id,
        epoch,
        saved_at_seq: records.length - 1,
        projection,
    };
    const journal = records.map((record) => `${canonicalJson(record)}\n`).join("");
    const dir = join(root, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "descriptor.json"), canonicalJson(sealed));
    if (journal !== "")
        writeFileSync(join(dir, "journal.jsonl"), journal);
    writeFileSync(join(dir, "projection.json"), JSON.stringify(envelope));
    return { dir, sealed, journal, records, projection, envelope };
}
//# sourceMappingURL=real-run-fixtures.js.map