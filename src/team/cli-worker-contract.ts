/**
 * CLI-worker output contract (Option E, plan AC-7).
 *
 * When a /team critic/reviewer stage is routed to an external CLI worker
 * (codex or gemini), the worker is a one-shot process that cannot call
 * TaskUpdate directly. To surface a structured verdict back to the team
 * leader, the worker writes a JSON payload to a pre-agreed file path
 * before exit. The leader's worker-completion handler in runtime-v2 reads
 * the file and calls TaskUpdate with verdict metadata.
 *
 * Applies to roles in CONTRACT_ROLES (critic, code-reviewer,
 * security-reviewer, test-engineer) when the resolved provider is
 * `codex` or `gemini`. Claude workers participate in team messaging
 * directly and do not use this contract.
 */

import type { CanonicalTeamRole } from '../shared/types.js';
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
}

const VALID_VERDICTS: ReadonlySet<string> = new Set(['approve', 'revise', 'reject']);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'major', 'minor', 'nit']);

/**
 * Returns true when a role + provider pair requires the verdict-output contract.
 * External providers (codex/gemini) on reviewer-style roles need it; Claude
 * teammates speak through the team messaging API directly.
 */
export function shouldInjectContract(
  role: CanonicalTeamRole | null | undefined,
  provider: CliAgentType | null | undefined,
): boolean {
  if (!role || !provider) return false;
  if (provider === 'claude') return false;
  return CONTRACT_ROLES.has(role);
}

/**
 * Render the prompt fragment that instructs the CLI worker to emit a
 * structured verdict JSON to `output_file` before exiting. Appended to
 * the task instruction + startup prompt for reviewer roles.
 */
export function renderCliWorkerOutputContract(
  role: CanonicalTeamRole,
  output_file: string,
): string {
  return [
    '',
    '---',
    '## REQUIRED: Structured Verdict Output',
    '',
    `You are acting in the \`${role}\` role. Before you exit, write a JSON verdict to:`,
    '',
    `    ${output_file}`,
    '',
    'Schema (all keys required; `findings` may be an empty array):',
    '',
    '```json',
    '{',
    `  "role": "${role}",`,
    '  "task_id": "<task id from the assignment above>",',
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
  };
}

/**
 * Compute the conventional verdict-output file path for a team worker.
 * Kept as a single source of truth so spawn and completion handler agree.
 */
export function cliWorkerOutputFilePath(
  teamStateRootAbs: string,
  workerName: string,
): string {
  // Intentional forward-slash join — consumed by prompts rendered for CLI
  // workers, matches other team state path conventions.
  return `${teamStateRootAbs.replaceAll('\\', '/')}/workers/${workerName}/verdict.json`;
}
