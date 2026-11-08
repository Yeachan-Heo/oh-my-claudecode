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
import { TASK_ID_SAFE_PATTERN } from './contracts.js';
import type { CliAgentType } from './model-contract.js';

/** Roles that emit a structured verdict and therefore use the output-file contract. */
export const CONTRACT_ROLES: ReadonlySet<CanonicalTeamRole> = new Set<CanonicalTeamRole>([
  'critic',
  'code-reviewer',
  'security-reviewer',
  'test-engineer',
]);

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

const VALID_VERDICTS: ReadonlySet<string> = new Set(['approve', 'revise', 'reject']);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'major', 'minor', 'nit']);

/**
 * Returns true when a role + provider pair requires the verdict-output contract.
 * Every external provider (codex/gemini/grok/cursor/antigravity) on a
 * reviewer-style role needs it; Claude teammates speak through the team
 * messaging API directly.
 */
export function shouldInjectContract(
  role: CanonicalTeamRole | null | undefined,
  provider: CliAgentType | null | undefined,
): boolean {
  if (!role || !provider) return false;
  // Claude workers speak through the team messaging API directly.
  if (provider === 'claude') return false;
  return CONTRACT_ROLES.has(role);
}

/**
 * Render the prompt fragment that instructs the CLI worker to emit a
 * structured verdict JSON to `output_file` before exiting or yielding the
 * reviewer turn. Appended to the task instruction + startup prompt for
 * reviewer roles.
 */
export function renderCliWorkerOutputContract(
  role: CanonicalTeamRole,
  output_file: string,
  identity: CliWorkerVerdictIdentity = {},
): string {
  return [
    '',
    '---',
    '## REQUIRED: Structured Verdict Output',
    '',
    `You are acting in the \`${role}\` role. Before you exit or yield this reviewer turn, write a JSON verdict to:`,
    '',
    `    ${output_file}`,
    '',
    'Schema (all keys required; `findings` may be an empty array):',
    '',
    '```json',
    '{',
    `  "role": "${role}",`,
    `  "task_id": "${identity.taskId ?? '<task id from the assignment above>'}",`,
    `  "claim_token": "${identity.claimToken ?? '<claim token from the claim response>'}",`,
    `  "task_version": ${identity.taskVersion ?? '<task version from the claim response>'},`,
    `  "launch_attempt_id": "${identity.launchAttemptId ?? '<exact OMC_WORKER_LAUNCH_ATTEMPT_ID>'}",`,
    '  "verdict": "approve" | "revise" | "reject",',
    '  "summary": "one- or two-sentence overall assessment",',
    '  "findings": [',
    '    {',
    '      "severity": "critical" | "major" | "minor" | "nit",',
    '      "message": "what is wrong and why it matters",',
    '      "file": "optional/path/to/file",',
    '      "line": 42',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Rules:',
    '- Write valid JSON only (no surrounding prose, no markdown fences in the file).',
    '- `verdict` MUST be one of `approve`, `revise`, or `reject`.',
    '- Each finding MUST carry a `severity` from the enum above.',
    '- Use `approve` only when you have no blocking concerns.',
    '- If you cannot produce a verdict, write `{"verdict":"revise", ...}` with an explanatory finding rather than exiting silently.',
    '- Writing the verdict does not itself authorize leaving a persistent interactive worker session; remain available for further mailbox instructions unless the leader explicitly shuts you down.',
    '- The team leader reads this file to mark the task complete; omitting it leaves the task stuck in_progress pending human review.',
    '',
  ].join('\n');
}

/**
 * Parse and validate a verdict JSON string produced by a CLI worker.
 * Returns the parsed payload on success; throws with a specific reason
 * otherwise so the completion handler can surface it in a warning.
 */
export function parseCliWorkerVerdict(raw: string): CliWorkerOutputPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`verdict_json_parse_failed: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('verdict_not_object');
  }
  const obj = parsed as Record<string, unknown>;

  const role = obj.role;
  if (typeof role !== 'string' || !role) {
    throw new Error('verdict_missing_role');
  }
  const taskId = obj.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('verdict_missing_task_id');
  }
  if (!TASK_ID_SAFE_PATTERN.test(taskId)) {
    throw new Error(`verdict_invalid_task_id:${taskId}`);
  }
  const claimToken = obj.claim_token;
  if (claimToken !== undefined && (typeof claimToken !== 'string' || !claimToken)) {
    throw new Error('verdict_invalid_claim_token');
  }
  const taskVersion = obj.task_version;
  if (taskVersion !== undefined && (typeof taskVersion !== 'number' || !Number.isInteger(taskVersion) || taskVersion < 0)) {
    throw new Error('verdict_invalid_task_version');
  }
  const launchAttemptId = obj.launch_attempt_id;
  if (launchAttemptId !== undefined && (typeof launchAttemptId !== 'string' || !launchAttemptId)) {
    throw new Error('verdict_invalid_launch_attempt_id');
  }
  const verdict = obj.verdict;
  if (typeof verdict !== 'string' || !VALID_VERDICTS.has(verdict)) {
    throw new Error(`verdict_invalid_verdict:${String(verdict)}`);
  }
  const summary = obj.summary;
  if (typeof summary !== 'string') {
    throw new Error('verdict_missing_summary');
  }
  const findingsRaw = obj.findings;
  if (!Array.isArray(findingsRaw)) {
    throw new Error('verdict_findings_not_array');
  }

  const findings: CliWorkerFinding[] = findingsRaw.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`verdict_finding_${idx}_not_object`);
    }
    const f = entry as Record<string, unknown>;
    const severity = f.severity;
    if (typeof severity !== 'string' || !VALID_SEVERITIES.has(severity)) {
      throw new Error(`verdict_finding_${idx}_invalid_severity:${String(severity)}`);
    }
    const message = f.message;
    if (typeof message !== 'string' || !message) {
      throw new Error(`verdict_finding_${idx}_missing_message`);
    }
    const finding: CliWorkerFinding = {
      severity: severity as CliWorkerFindingSeverity,
      message,
    };
    if (typeof f.file === 'string' && f.file) finding.file = f.file;
    if (typeof f.line === 'number' && Number.isFinite(f.line)) finding.line = f.line;
    return finding;
  });

  return {
    role: role as CanonicalTeamRole,
    task_id: taskId,
    verdict: verdict as CliWorkerVerdict,
    summary,
    findings,
    ...(claimToken !== undefined ? { claim_token: claimToken } : {}),
    ...(taskVersion !== undefined ? { task_version: taskVersion } : {}),
    ...(launchAttemptId !== undefined ? { launch_attempt_id: launchAttemptId } : {}),
  };
}

/**
 * Compute the conventional verdict-output file path for a team worker.
 * Kept as a single source of truth so spawn and completion handler agree.
 */
export function cliWorkerOutputFilePath(
  teamStateRootAbs: string,
  workerName: string,
  scope?: { taskId?: string; assignmentId?: string; launchAttemptId?: string },
): string {
  // Intentional forward-slash join — consumed by prompts rendered for CLI
  // workers, matches other team state path conventions.
  const taskId = scope?.taskId;
  const assignmentId = scope?.assignmentId ?? scope?.launchAttemptId;
  const fileName = taskId && assignmentId
    ? `verdict-${encodeURIComponent(taskId)}-${encodeURIComponent(assignmentId)}.json`
    : 'verdict.json';
  return `${teamStateRootAbs.replaceAll('\\', '/')}/workers/${workerName}/${fileName}`;
}

export function isCliWorkerOutputFilePath(
  teamStateRootAbs: string,
  workerName: string,
  outputFile: string,
): boolean {
  const root = `${teamStateRootAbs.replaceAll('\\', '/')}/workers/${workerName}/`;
  const normalized = outputFile.replaceAll('\\', '/');
  return normalized.startsWith(root)
    && (normalized === `${root}verdict.json`
      || /^verdict-[^/]+-[^/]+\.json$/.test(normalized.slice(root.length)));
}
