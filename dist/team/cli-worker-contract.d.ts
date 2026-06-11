/**
 * CLI-worker output contract (Option E, plan AC-7).
 *
 * When a /team critic/reviewer stage is routed to an external CLI worker
 * (codex or gemini), the worker may not call TaskUpdate directly. To surface
 * a structured verdict back to the team leader, the worker writes a JSON
 * payload to a pre-agreed file path. The leader's worker-completion handler
 * in runtime-v2 reads the file and calls TaskUpdate with verdict metadata.
 *
 * Applies to roles in CONTRACT_ROLES (critic, code-reviewer,
 * security-reviewer, test-engineer) when the resolved provider is
 * `codex` or `gemini`. Claude workers participate in team messaging
 * directly and do not use this contract. Codex team workers are launched as
 * persistent `codex` panes, not `codex exec`; they still receive this verdict
 * contract in their inbox when assigned reviewer-style roles.
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
}
/**
 * Returns true when a role + provider pair requires the verdict-output contract.
 * External providers (codex/gemini/grok) on reviewer-style roles need it; Claude
 * teammates speak through the team messaging API directly.
 */
export declare function shouldInjectContract(role: CanonicalTeamRole | null | undefined, provider: CliAgentType | null | undefined): boolean;
/**
 * Render the prompt fragment that instructs the CLI worker to emit a
 * structured verdict JSON to `output_file` before exiting. Appended to
 * the task instruction + startup prompt for reviewer roles.
 */
export declare function renderCliWorkerOutputContract(role: CanonicalTeamRole, output_file: string): string;
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
export declare function cliWorkerOutputFilePath(teamStateRootAbs: string, workerName: string): string;
//# sourceMappingURL=cli-worker-contract.d.ts.map