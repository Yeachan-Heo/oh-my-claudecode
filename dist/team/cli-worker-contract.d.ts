/**
 * CLI-worker output contract (Option E, plan AC-7).
 *
 * When a /team critic/reviewer stage is routed to an external CLI worker,
 * the worker may not call TaskUpdate directly. To surface a structured
 * verdict back to the team leader, the worker writes a JSON payload to a
 * pre-agreed file path. The leader's worker-completion handler in
 * runtime-v2 reads the file and calls TaskUpdate with verdict metadata.
 *
 * Applies to roles in CONTRACT_ROLES (critic, code-reviewer,
 * security-reviewer, test-engineer) on every non-Claude provider. Claude
 * workers participate in team messaging directly and do not use this
 * contract.
 *
 * The contract does not require a one-shot CLI. It is a prompt instruction
 * plus a file the leader polls, so persistent interactive panes satisfy it:
 * codex and cursor team workers are launched as long-lived panes (not
 * `codex exec` / `cursor-agent -p`) and still receive this verdict contract
 * in their inbox when assigned reviewer-style roles.
 */
import type { CanonicalTeamRole } from '../shared/types.js';
import type { CliAgentType } from './model-contract.js';
/** Roles that emit a structured verdict and therefore use the output-file contract. */
export declare const CONTRACT_ROLES: ReadonlySet<CanonicalTeamRole>;
export type CliWorkerVerdict = 'approve' | 'revise' | 'reject';
export type CliWorkerFindingSeverity = 'critical' | 'major' | 'minor' | 'nit';
export interface CliWorkerFinding {
    severity: CliWorkerFindingSeverity;
    message: string;
    file?: string;
    line?: number;
}
export interface CliWorkerOutputPayload {
    role: CanonicalTeamRole;
    task_id: string;
    verdict: CliWorkerVerdict;
    summary: string;
    findings: CliWorkerFinding[];
    claim_token?: string;
    task_version?: number;
    launch_attempt_id?: string;
}
export interface CliWorkerVerdictIdentity {
    taskId?: string;
    claimToken?: string;
    taskVersion?: number;
    launchAttemptId?: string;
}
/**
 * Returns true when a role + provider pair requires the verdict-output contract.
 * Every external provider (codex/gemini/grok/cursor/antigravity) on a
 * reviewer-style role needs it; Claude teammates speak through the team
 * messaging API directly.
 */
export declare function shouldInjectContract(role: CanonicalTeamRole | null | undefined, provider: CliAgentType | null | undefined): boolean;
/**
 * Render the prompt fragment that instructs the CLI worker to emit a
 * structured verdict JSON to `output_file` before exiting or yielding the
 * reviewer turn. Appended to the task instruction + startup prompt for
 * reviewer roles.
 */
export declare function renderCliWorkerOutputContract(role: CanonicalTeamRole, output_file: string, identity?: CliWorkerVerdictIdentity): string;
/**
 * Parse and validate a verdict JSON string produced by a CLI worker.
 * Returns the parsed payload on success; throws with a specific reason
 * otherwise so the completion handler can surface it in a warning.
 */
export declare function parseCliWorkerVerdict(raw: string): CliWorkerOutputPayload;
/**
 * Compute the conventional verdict-output file path for a team worker.
 * Kept as a single source of truth so spawn and completion handler agree.
 */
export declare function cliWorkerOutputFilePath(teamStateRootAbs: string, workerName: string, scope?: {
    taskId?: string;
    assignmentId?: string;
    launchAttemptId?: string;
}): string;
export declare function isCliWorkerOutputFilePath(teamStateRootAbs: string, workerName: string, outputFile: string): boolean;
//# sourceMappingURL=cli-worker-contract.d.ts.map