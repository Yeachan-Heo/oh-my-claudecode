/**
 * Remote approval gate (graph runtime v2).
 *
 * Bridges the frozen HumanApprovalPrompter contract to a file-backed
 * decision exchange plus an optional notifier, so approvals can be
 * granted from outside the interactive terminal (via `omc graph
 * approvals decide`, and later via notification reply channels).
 *
 * Protocol (all files live inside the contained run directory):
 *   <runDir>/approvals/pending/<activationId>.json    written by the gate
 *   <runDir>/approvals/decisions/<activationId>.json  written by a decider
 *
 * Fail-closed by construction, mirroring createStdinApprovalGate:
 *   - malformed or unknown decisions never resolve a request (the gate
 *     keeps waiting for a well-formed one)
 *   - an expired request resolves to the configured timeout policy
 *     (default: denied)
 *   - decision artifacts carry no trust: the runner records the outcome
 *     in its own journal, so a forged decision file can only flip a
 *     human-approval node, exactly like typing y at the stdin prompt
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { assertSafeContainedFileName, readOperationFileNoFollow, withContainedSubdirectoryOperations, writeOperationFileAtomically, } from "./safe-fs.js";
import { resolveRunDirHandle } from "./run-dir.js";
const APPROVALS_DIR = "approvals";
const PENDING_DIR = "pending";
const DECISIONS_DIR = "decisions";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_POLICY = "denied";
const DECISION_VALUES = new Set(["approved", "denied"]);
const PENDING_COMPONENTS = [APPROVALS_DIR, PENDING_DIR];
const DECISIONS_COMPONENTS = [APPROVALS_DIR, DECISIONS_DIR];
/**
 * Approval artifacts live two components below the run directory, so the
 * nested traversal is the containment boundary: both `approvals` and its
 * child are opened O_NOFOLLOW from the parent descriptor. A directory swapped
 * for a symlink between validation and use fails closed instead of
 * redirecting a trust decision outside the run directory.
 */
function withApprovalOperations(runDir, components, create, operation) {
    return withContainedSubdirectoryOperations(runDir, components, operation, { create });
}
function artifactFileName(activationId) {
    // Activation ids come from the sealed descriptor and are therefore
    // untrusted; refuse traversal-shaped or normalization-ambiguous values.
    assertSafeContainedFileName(activationId);
    return `${activationId}.json`;
}
/**
 * Parse one decision artifact. Returns null for anything that is not a
 * well-formed decision — malformed files are ignored, never trusted.
 */
export function parseDecisionArtifact(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const candidate = parsed;
    if (!DECISION_VALUES.has(candidate.decision))
        return null;
    if (candidate.decided_at !== undefined &&
        typeof candidate.decided_at !== "string") {
        return null;
    }
    if (candidate.decided_by !== undefined &&
        typeof candidate.decided_by !== "string") {
        return null;
    }
    return {
        decision: candidate.decision,
        decided_at: typeof candidate.decided_at === "string"
            ? candidate.decided_at
            : new Date().toISOString(),
        ...(typeof candidate.decided_by === "string"
            ? { decided_by: candidate.decided_by }
            : {}),
    };
}
function readDecisionFile(runDir, activationId) {
    const fileName = artifactFileName(activationId);
    try {
        return withApprovalOperations(runDir, DECISIONS_COMPONENTS, false, (operations) => parseDecisionArtifact(readOperationFileNoFollow(operations, fileName)));
    }
    catch {
        return null;
    }
}
/** Retire our own pending artifact through the contained descriptor. */
function retirePendingArtifact(runDir, activationId) {
    try {
        withApprovalOperations(runDir, PENDING_COMPONENTS, false, (operations) => {
            operations.unlink(artifactFileName(activationId));
        });
    }
    catch {
        // A missing pending file is fine; leaving one behind only affects
        // `approvals list` freshness, never run correctness.
    }
}
/**
 * Create a remote approval gate. Each prompt persists a pending artifact,
 * fires the best-effort notifier once, then polls for a decision artifact
 * until one resolves or the optional timeout expires.
 */
export function createRemoteApprovalGate(options) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutPolicy = options.timeoutPolicy ?? DEFAULT_TIMEOUT_POLICY;
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    return {
        async prompt(request) {
            const runDir = resolveRunDirHandle(options.runsRoot, options.runId);
            assertSafeContainedFileName(request.activation_id);
            assertSafeContainedFileName(request.node_id);
            const record = {
                run_id: request.run_id,
                node_id: request.node_id,
                activation_id: request.activation_id,
                prompt_text: request.prompt_text,
                created_at: new Date(now()).toISOString(),
            };
            withApprovalOperations(runDir, PENDING_COMPONENTS, true, (operations) => {
                writeOperationFileAtomically(operations, artifactFileName(request.activation_id), `${JSON.stringify(record, null, 2)}\n`);
            });
            if (options.notifier !== undefined) {
                try {
                    await options.notifier(request, record);
                }
                catch {
                    // Notification delivery is best-effort; the decision file is the
                    // source of truth and the gate must never fail on notifier errors.
                }
            }
            const startedAtMs = now();
            for (;;) {
                const decision = readDecisionFile(runDir, request.activation_id);
                if (decision !== null) {
                    // Resolution observed: retire the pending artifact (best-effort).
                    retirePendingArtifact(runDir, request.activation_id);
                    return decision.decision;
                }
                // An aborted/killed run must not hang in the poll loop: resolve
                // denied (fail closed) and let the runner's fence settle ownership.
                if (options.signal?.aborted === true) {
                    retirePendingArtifact(runDir, request.activation_id);
                    return "denied";
                }
                if (options.timeoutMs !== undefined &&
                    now() - startedAtMs >= options.timeoutMs) {
                    retirePendingArtifact(runDir, request.activation_id);
                    return timeoutPolicy;
                }
                await sleep(pollIntervalMs);
            }
        },
    };
}
/**
 * List unresolved approval requests across all runs in a runs root.
 * Read-only: runs with malformed or unreadable artifacts are skipped.
 */
export function listPendingApprovals(runsRoot) {
    let runIds;
    try {
        runIds = readdirSync(runsRoot);
    }
    catch {
        return [];
    }
    const entries = [];
    for (const runId of runIds) {
        let runDir;
        try {
            runDir = resolveRunDirHandle(runsRoot, runId);
        }
        catch {
            // Malformed run id or a symlinked run directory: never listed.
            continue;
        }
        try {
            withApprovalOperations(runDir, PENDING_COMPONENTS, false, (operations) => {
                for (const file of operations.readDir()) {
                    if (!file.endsWith(".json"))
                        continue;
                    try {
                        const parsed = JSON.parse(readOperationFileNoFollow(operations, file));
                        if (typeof parsed.run_id !== "string" ||
                            typeof parsed.node_id !== "string" ||
                            typeof parsed.activation_id !== "string" ||
                            typeof parsed.prompt_text !== "string" ||
                            typeof parsed.created_at !== "string") {
                            continue;
                        }
                        entries.push({
                            run_id: parsed.run_id,
                            activation_id: parsed.activation_id,
                            node_id: parsed.node_id,
                            prompt_text: parsed.prompt_text,
                            created_at: parsed.created_at,
                        });
                    }
                    catch {
                        continue;
                    }
                }
            });
        }
        catch {
            continue;
        }
    }
    return entries.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
/**
 * Persist one decision artifact on behalf of a human decider (the
 * `omc graph approvals decide` CLI path). Fails closed on malformed ids
 * and on unknown runs: the run directory must already exist (the gate
 * creates it), so a typo'd run id is an error rather than a decision
 * written into a directory nobody polls.
 */
export function writeApprovalDecision(runsRoot, runId, activationId, decision, decidedBy) {
    assertSafeContainedFileName(runId);
    assertSafeContainedFileName(activationId);
    if (!existsSync(join(runsRoot, runId))) {
        throw new Error(`unknown run "${runId}" (no run directory under ${runsRoot})`);
    }
    const runDir = resolveRunDirHandle(runsRoot, runId);
    const record = {
        decision,
        decided_at: new Date().toISOString(),
        ...(decidedBy !== undefined ? { decided_by: decidedBy } : {}),
    };
    withApprovalOperations(runDir, DECISIONS_COMPONENTS, true, (operations) => {
        writeOperationFileAtomically(operations, artifactFileName(activationId), `${JSON.stringify(record, null, 2)}\n`);
    });
    return record;
}
/**
 * Remove a run's pending artifacts (best-effort housekeeping).
 *
 * Descriptor-relative unlink of the entries rather than a recursive pathname
 * removal: `rmSync` on `<runDir>/approvals/pending` would re-resolve the
 * nested pathname and could follow a swapped component. The now-empty
 * directory is left in place, which only affects listing freshness.
 */
export function prunePendingApprovals(runsRoot, runId) {
    try {
        assertSafeContainedFileName(runId);
        const runDir = resolveRunDirHandle(runsRoot, runId);
        withApprovalOperations(runDir, PENDING_COMPONENTS, false, (operations) => {
            for (const file of operations.readDir()) {
                try {
                    operations.unlink(file);
                }
                catch {
                    // Skip entries we cannot retire; housekeeping never surfaces.
                }
            }
        });
    }
    catch {
        // Housekeeping only; never surface.
    }
}
//# sourceMappingURL=remote-approval.js.map