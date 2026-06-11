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
/** Roles that emit a structured verdict and therefore use the output-file contract. */
export const CONTRACT_ROLES = new Set([
    'critic',
    'code-reviewer',
    'security-reviewer',
    'test-engineer',
]);
const VALID_VERDICTS = new Set(['approve', 'revise', 'reject']);
const VALID_SEVERITIES = new Set(['critical', 'major', 'minor', 'nit']);
/**
 * Returns true when a role + provider pair requires the verdict-output contract.
 * External providers (codex/gemini/grok) on reviewer-style roles need it; Claude
 * teammates speak through the team messaging API directly.
 */
export function shouldInjectContract(role, provider) {
    if (!role || !provider)
        return false;
    // Claude workers speak through the team messaging API directly.
    // Cursor workers run as interactive REPLs — they cannot perform the
    // write-verdict-and-exit dance the contract requires, so reviewer
    // roles must not be assigned to cursor in the first place. The
    // role-router and worker-bootstrap guidance both flag this; here we
    // simply skip contract injection if a cursor worker somehow lands on
    // a CONTRACT_ROLES role rather than emit instructions it cannot follow.
    if (provider === 'claude' || provider === 'cursor')
        return false;
    return CONTRACT_ROLES.has(role);
}
/**
 * Render the prompt fragment that instructs the CLI worker to emit a
 * structured verdict JSON to `output_file` before exiting. Appended to
 * the task instruction + startup prompt for reviewer roles.
 */
export function renderCliWorkerOutputContract(role, output_file) {
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
export function parseCliWorkerVerdict(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`verdict_json_parse_failed: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('verdict_not_object');
    }
    const obj = parsed;
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
    const findings = findingsRaw.map((entry, idx) => {
        if (!entry || typeof entry !== 'object') {
            throw new Error(`verdict_finding_${idx}_not_object`);
        }
        const f = entry;
        const severity = f.severity;
        if (typeof severity !== 'string' || !VALID_SEVERITIES.has(severity)) {
            throw new Error(`verdict_finding_${idx}_invalid_severity:${String(severity)}`);
        }
        const message = f.message;
        if (typeof message !== 'string' || !message) {
            throw new Error(`verdict_finding_${idx}_missing_message`);
        }
        const finding = {
            severity: severity,
            message,
        };
        if (typeof f.file === 'string' && f.file)
            finding.file = f.file;
        if (typeof f.line === 'number' && Number.isFinite(f.line))
            finding.line = f.line;
        return finding;
    });
    return {
        role: role,
        task_id: taskId,
        verdict: verdict,
        summary,
        findings,
    };
}
/**
 * Compute the conventional verdict-output file path for a team worker.
 * Kept as a single source of truth so spawn and completion handler agree.
 */
export function cliWorkerOutputFilePath(teamStateRootAbs, workerName) {
    // Intentional forward-slash join — consumed by prompts rendered for CLI
    // workers, matches other team state path conventions.
    return `${teamStateRootAbs.replaceAll('\\', '/')}/workers/${workerName}/verdict.json`;
}
//# sourceMappingURL=cli-worker-contract.js.map