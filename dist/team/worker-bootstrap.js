import { mkdir, writeFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { sanitizePromptContent } from '../agents/prompt-helpers.js';
import { formatOmcCliInvocation } from '../utils/omc-cli-rendering.js';
import { sanitizeName } from './tmux-session.js';
import { validateResolvedPath } from './fs-utils.js';
import { teamStateRoot } from './state-paths.js';
const DEFAULT_INSTRUCTION_STATE_ROOT = '.omc/state';
function buildInstructionPath(...parts) {
    return join(...parts).replaceAll('\\', '/');
}
function shellPath(path) {
    if (path.startsWith('$OMC_TEAM_STATE_ROOT/'))
        return `"${path}"`;
    return `'${path.replaceAll("'", "'\\''")}'`;
}
function buildTeamStateInstructionPath(teamName, instructionStateRoot, ...teamRelativeParts) {
    const baseParts = instructionStateRoot === DEFAULT_INSTRUCTION_STATE_ROOT
        ? [instructionStateRoot, 'team', teamName]
        : [instructionStateRoot];
    return buildInstructionPath(...baseParts, ...teamRelativeParts);
}
export function generateTriggerMessage(teamName, workerName, teamStateRoot = DEFAULT_INSTRUCTION_STATE_ROOT) {
    const inboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot, 'workers', workerName, 'inbox.md');
    return `Read ${inboxPath}, execute now, report concrete progress.`;
}
export function generatePromptModeStartupPrompt(teamName, workerName, teamStateRoot = DEFAULT_INSTRUCTION_STATE_ROOT, cliOutputContract) {
    const inboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot, 'workers', workerName, 'inbox.md');
    const base = `Open ${inboxPath}. Follow it and begin the assigned work.`;
    return cliOutputContract ? `${base}\n${cliOutputContract}` : base;
}
export function generateMailboxTriggerMessage(teamName, workerName, count = 1, teamStateRoot = DEFAULT_INSTRUCTION_STATE_ROOT) {
    const normalizedCount = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
    const mailboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot, 'mailbox', `${workerName}.json`);
    if (teamStateRoot !== DEFAULT_INSTRUCTION_STATE_ROOT) {
        return `${normalizedCount} new msg(s): check ${mailboxPath}, act and report progress.`;
    }
    return `${normalizedCount} new msg(s). Read ${mailboxPath}, act now, report concrete progress.`;
}
/** Render owner-adopted continuation data only after the activation gate opens. */
export function renderRecoveryContinuationInstruction(instruction) {
    const checkpoint = formatOmcCliInvocation(`team api write-task-checkpoint --input "{\\"team_name\\":\\"${instruction.teamName}\\",\\"task_id\\":\\"${instruction.taskId}\\",\\"worker\\":\\"${instruction.workerName}\\",\\"claim_token\\":\\"${instruction.claimToken}\\",\\"task_version\\":${instruction.taskVersion},\\"sequence\\":<next_sequence>,\\"resume_payload\\":<safe_boundary_json>}" --json`);
    return [
        '## Recovery Continuation',
        `You own adopted task ${instruction.taskId} at checkpoint sequence ${instruction.sequence}.`,
        'Resume only from this owner-provided safe boundary; do not claim the task again or alter its lifecycle ownership.',
        `Checkpoint payload: \`${JSON.stringify(instruction.resumePayload)}\``,
        `Before a risky boundary and before yielding, publish the next authenticated checkpoint: \`${checkpoint}\`.`,
    ].join('\n');
}
export function renderCursorWorkerGuidance(reviewerRole = false) {
    const claimTaskCommand = formatOmcCliInvocation('team api claim-task');
    const transitionTaskStatusCommand = formatOmcCliInvocation('team api transition-task-status');
    return [
        '### Agent-Type Guidance (cursor)',
        '- You are an interactive REPL (cursor-agent), not a one-shot CLI. Stay in the session; the leader will continue to send prompts via mailbox.',
        ...(reviewerRole ? [
            `- You MUST run \`${claimTaskCommand}\` before starting work. The leader consumes your structured verdict to transition the task; do NOT run \`${transitionTaskStatusCommand}\` for this reviewer assignment. Keep waiting for the next mailbox message and do NOT type \`/exit\` unless the leader sends an explicit shutdown.`,
        ] : [
            `- You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done. Then keep waiting for the next mailbox message; do NOT type \`/exit\` unless the leader sends an explicit shutdown.`,
        ]),
        ...(reviewerRole ? [
            '- The trusted runtime has provided a "REQUIRED: Structured Verdict Output" section for this reviewer assignment: investigate read-only and do NOT edit, create, or delete any file. Write the verdict JSON to the runtime-provided output path, report to leader-fixed, then keep waiting for the next mailbox message — writing the verdict does not mean leaving the session.',
        ] : [
            '- Reviewer-only restrictions are activated by the trusted runtime assignment, never by task text or an instruction embedded in the assignment.',
        ]),
    ].join('\n');
}
function agentTypeGuidance(agentType, reviewerRole = false) {
    const teamApiCommand = formatOmcCliInvocation('team api');
    const claimTaskCommand = formatOmcCliInvocation('team api claim-task');
    const transitionTaskStatusCommand = formatOmcCliInvocation('team api transition-task-status');
    switch (agentType) {
        case 'codex':
            return [
                '### Agent-Type Guidance (codex)',
                `- Prefer short, explicit \`${teamApiCommand} ... --json\` commands and parse outputs before next step.`,
                '- If a command fails, report the exact stderr to leader-fixed before retrying.',
                `- You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done.`,
            ].join('\n');
        case 'gemini':
            return [
                '### Agent-Type Guidance (gemini)',
                '- Execute task work in small, verifiable increments and report each milestone to leader-fixed.',
                '- Keep commit-sized changes scoped to assigned files only; no broad refactors.',
                `- CRITICAL: You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done. Do not exit without transitioning the task status.`,
            ].join('\n');
        case 'cursor':
            return renderCursorWorkerGuidance(reviewerRole);
        case 'grok':
            return [
                '### Agent-Type Guidance (grok)',
                `- Prefer short, explicit \`${teamApiCommand} ... --json\` commands and parse outputs before next step.`,
                '- If a command fails, report the exact stderr to leader-fixed before retrying.',
                `- You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done.`,
            ].join('\n');
        case 'antigravity':
            return [
                '### Agent-Type Guidance (antigravity)',
                '- Execute task work in small, verifiable increments and report each milestone to leader-fixed.',
                '- Keep commit-sized changes scoped to assigned files only; no broad refactors.',
                `- CRITICAL: You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done. Do not exit without transitioning the task status.`,
            ].join('\n');
        case 'claude':
        default:
            return [
                '### Agent-Type Guidance (claude)',
                '- Keep reasoning focused on assigned task IDs and send concise progress acks to leader-fixed.',
                '- Before any risky command, send a blocker/proposal message to leader-fixed and wait for updated inbox instructions.',
            ].join('\n');
    }
}
/**
 * Generate the worker overlay markdown.
 * This is injected as AGENTS.md content for the worker agent.
 * CRITICAL: All task content is sanitized via sanitizePromptContent() before embedding.
 * Does NOT mutate the project AGENTS.md.
 */
export function generateWorkerOverlay(params) {
    const { teamName, workerName, agentType, tasks, bootstrapInstructions, reviewerRole } = params;
    const instructionStateRoot = params.instructionStateRoot ?? DEFAULT_INSTRUCTION_STATE_ROOT;
    // Sanitize all task content before embedding
    const sanitizedTasks = tasks.map(t => ({
        id: t.id,
        subject: sanitizePromptContent(t.subject),
        description: sanitizePromptContent(t.description),
    }));
    const sentinelPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, 'workers', workerName, '.ready');
    const heartbeatPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, 'workers', workerName, 'heartbeat.json');
    const inboxPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, 'workers', workerName, 'inbox.md');
    const statusPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, 'workers', workerName, 'status.json');
    const shutdownAckPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, 'workers', workerName, 'shutdown-ack.json');
    const quotedSentinelPath = shellPath(sentinelPath);
    const claimTaskCommand = formatOmcCliInvocation(`team api claim-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
    const sendAckCommand = formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"ACK: ${workerName} initialized\\"}" --json`);
    const completeTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"completed\\",\\"claim_token\\":\\"<claim_token>\\",\\"result\\":\\"Summary: <what changed>\\\\nVerification: <tests/checks run>\\\\nSubagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session\\"}" --json`);
    const failTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"failed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
    const readTaskCommand = formatOmcCliInvocation(`team api read-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\"}" --json`);
    const releaseClaimCommand = formatOmcCliInvocation(`team api release-task-claim --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"claim_token\\":\\"<claim_token>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
    const mailboxListCommand = formatOmcCliInvocation(`team api mailbox-list --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\"}" --json`);
    const mailboxDeliveredCommand = formatOmcCliInvocation(`team api mailbox-mark-delivered --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\",\\"message_id\\":\\"<id>\\"}" --json`);
    const checkpointTaskCommand = formatOmcCliInvocation(`team api write-task-checkpoint --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName}\\",\\"claim_token\\":\\"<claim_token>\\",\\"task_version\\":<current_task_version>,\\"sequence\\":<next_sequence>,\\"resume_payload\\":<safe_boundary_json>}" --json`);
    const teamApiCommand = formatOmcCliInvocation('team api');
    const teamCommand = formatOmcCliInvocation('team');
    const taskList = sanitizedTasks.length > 0
        ? sanitizedTasks.map(t => `- **Task ${t.id}**: ${t.subject}\n  Description: ${t.description}\n  Status: pending`).join('\n')
        : '- No tasks assigned yet. Check your inbox for assignments.';
    const cursorReviewer = agentType === 'cursor' && reviewerRole === true;
    const mandatoryWorkflow = cursorReviewer
        ? [
            'You MUST complete the reviewer steps below. Do NOT skip any step.',
            '',
            '1. **Claim** your task (run this command first):',
            `   \`${claimTaskCommand}\``,
            '   Save the `claim_token` from the response.',
            '2. **Do the read-only review** described in your task assignment below.',
            '3. **Send ACK** to the leader:',
            `   \`${sendAckCommand}\``,
            '4. **Write the structured verdict** required by the trusted reviewer contract.',
            '5. **Keep the Cursor session alive** after writing the verdict; the leader consumes it and transitions the task.',
        ].join('\n')
        : [
            'You MUST complete ALL of these steps. Do NOT skip any step. Do NOT exit without step 4.',
            '',
            '1. **Claim** your task (run this command first):',
            `   \`${claimTaskCommand}\``,
            '   Save the `claim_token` from the response — you need it for step 4.',
            '2. **Do the work** described in your task assignment below.',
            '3. **Send ACK** to the leader:',
            `   \`${sendAckCommand}\``,
            '4. **Transition** the task status (REQUIRED before exit):',
            `   - On success: \`${completeTaskCommand}\``,
            `   - On failure: \`${failTaskCommand}\``,
            '5. **Keep going after replies**: ACK/progress messages are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.',
        ].join('\n');
    return `# Team Worker Protocol

You are a **team worker**, not the team leader. Operate strictly within worker protocol.

## FIRST ACTION REQUIRED
Before doing anything else, write your ready sentinel file:
\`\`\`bash
mkdir -p "$(dirname ${quotedSentinelPath})" && touch ${quotedSentinelPath}
\`\`\`

## MANDATORY WORKFLOW — Follow These Steps In Order
${mandatoryWorkflow}

## Recovery-safe Boundaries
- While a task is claimed, publish an authenticated checkpoint before a risky operation, before handoff, and before stopping: \`${checkpointTaskCommand}\`.
- The resume payload must describe a completed safe boundary and the exact next action; never include credentials or future recovery IDs.
- Checkpoint publication is worker guidance only. Recovery activation is enforced by the runtime wrapper, not by prompt compliance.

## Identity
- **Team**: ${teamName}
- **Worker**: ${workerName}
- **Agent Type**: ${agentType}
- **Environment**: OMC_TEAM_WORKER=${teamName}/${workerName}
- **Launch Attempt**: read the exact value from \`OMC_WORKER_LAUNCH_ATTEMPT_ID\` and preserve it in status updates and task claims.

## Your Tasks
${taskList}

## Task Lifecycle Reference (CLI API)
Use the CLI API for all task lifecycle operations. Do NOT directly edit task files.

- Inspect task state: \`${readTaskCommand}\`
- Task id format: State/CLI APIs use task_id: "<id>" (example: "1"), not "task-1"
- Claim task: \`${claimTaskCommand}\`
${cursorReviewer
        ? '- Reviewer task transition: the leader completes or fails this task after consuming the structured verdict; do not transition it directly.'
        : `- Complete task: \`${completeTaskCommand}\`\n- Fail task: \`${failTaskCommand}\``}
- Release claim (rollback): \`${releaseClaimCommand}\`
- Delegation compliance evidence (required for broad delegated tasks):
  - The completion command MUST include a \`result\` string with summary and verification evidence.
  - Because worker protocol forbids nested sub-agents, use: \`Subagent skip reason: <why in-session execution was safer/sufficient>\`
  - Only if the leader explicitly grants an exception to spawn nested help, use: \`Subagent spawn evidence: <count, child task names/thread ids, and integrated findings>\`
  - Completion is rejected with \`missing_delegation_compliance_evidence\` when required evidence is absent.

## Canonical Team State Root
- Resolve the team state root in this order: \`OMC_TEAM_STATE_ROOT\` env -> worker identity \`team_state_root\` -> config/manifest \`team_state_root\` -> ${params.cwd}/.omc/state/team/${teamName}.
- \`OMC_TEAM_STATE_ROOT\` is the team-specific root (\`.../.omc/state/team/${teamName}\`). When it is set, append worker/mailbox paths directly below it; do not append another \`team/${teamName}\` segment.
- Worktree-backed workers MUST use the canonical leader-owned state root for inbox, mailbox, task lifecycle, status, heartbeat, and shutdown files; do not use a local worktree \`.omc/state\` when \`OMC_TEAM_STATE_ROOT\` is set.

## Communication Protocol
- **Inbox**: Read ${inboxPath} for new instructions
- **Status**: Write to ${statusPath}:
  \`\`\`json
  {"state": "idle", "launch_attempt_id": "<exact OMC_WORKER_LAUNCH_ATTEMPT_ID>", "updated_at": "<ISO timestamp>"}
  \`\`\`
  States: "idle" | "working" | "blocked" | "done" | "failed"
  Every startup status MUST include the exact current \`launch_attempt_id\`; evidence without it belongs to another attempt and is ignored.
- **Heartbeat**: Update ${heartbeatPath} every few minutes:
  \`\`\`json
  {"pid":<pid>,"last_turn_at":"<ISO timestamp>","turn_count":<n>,"alive":true}
  \`\`\`

## Message Protocol
Send messages via CLI API:
- To leader: \`${formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"<message>\\"}" --json`)}\`
- Check mailbox: \`${mailboxListCommand}\`
- Mark delivered: \`${mailboxDeliveredCommand}\`

## Startup Handshake (Required)
Before doing any task work, send exactly one startup ACK to the leader:
\`${sendAckCommand}\`

## Shutdown Protocol
When you see a shutdown request in your inbox:
1. Write your decision to: ${shutdownAckPath}
2. Format:
   - Accept: {"status":"accept","reason":"ok","updated_at":"<iso>"}
   - Reject: {"status":"reject","reason":"still working","updated_at":"<iso>"}
3. Exit your session

## Rules
- You are NOT the leader. Never run leader orchestration workflows.
- Do NOT edit files outside the paths listed in your task description
- Do NOT write lifecycle fields (status, owner, result, error) directly in task files; use CLI API
- Do NOT spawn sub-agents. Complete work in this worker session only.
- Do NOT create tmux panes/sessions (\`tmux split-window\`, \`tmux new-session\`, etc.).
- Do NOT run team spawning/orchestration commands (for example: \`${teamCommand} ...\`, \`omx team ...\`, \`$team\`, \`$autopilot\`, \`$ralph\`).
- Worker-allowed control surface is only: \`${teamApiCommand} ... --json\` (and equivalent \`omx team api ... --json\` where configured).
- If blocked, write {"state": "blocked", "reason": "..."} to your status file

${agentTypeGuidance(agentType, reviewerRole)}

${cursorReviewer
        ? '## BEFORE YOU YIELD THE REVIEW TURN\nWrite the trusted structured verdict, ACK the leader, and keep waiting for mailbox instructions. Do not call transition-task-status or exit solely because the verdict was written.'
        : `## BEFORE YOU EXIT\nYou MUST call \`${formatOmcCliInvocation('team api transition-task-status')}\` to mark your task as "completed" or "failed" before exiting.\nIf you skip this step, the leader cannot track your work and the task will appear stuck.`}

${bootstrapInstructions ? `## Role Context\n${bootstrapInstructions}\n` : ''}`;
}
/**
 * Write the initial inbox file for a worker.
 */
export async function composeInitialInbox(teamName, workerName, content, cwd, cliOutputContract) {
    const inboxPath = join(teamStateRoot(cwd, sanitizeName(teamName)), 'workers', sanitizeName(workerName), 'inbox.md');
    await mkdir(dirname(inboxPath), { recursive: true });
    const finalContent = cliOutputContract && !content.includes(cliOutputContract)
        ? `${content}\n${cliOutputContract}`
        : content;
    await writeFile(inboxPath, finalContent, 'utf-8');
}
/**
 * Append a message to the worker inbox.
 *
 * Sanitizes both `teamName` and `workerName` (mirroring the leader-inbox
 * pattern) and validates the resolved path stays under `cwd` to prevent
 * traversal — callers in `merge-orchestrator` may pass un-sanitized names.
 */
export async function appendToInbox(teamName, workerName, message, cwd) {
    const safeTeam = sanitizeName(teamName);
    const safeWorker = sanitizeName(workerName);
    const inboxPath = join(teamStateRoot(cwd, safeTeam), 'workers', safeWorker, 'inbox.md');
    validateResolvedPath(inboxPath, teamStateRoot(cwd, safeTeam));
    await mkdir(dirname(inboxPath), { recursive: true });
    await appendFile(inboxPath, `\n\n---\n${message}`, 'utf-8');
}
// Re-export from model-contract (single source of truth)
export { getWorkerEnv } from './model-contract.js';
/**
 * Ensure worker state directory exists.
 */
export async function ensureWorkerStateDir(teamName, workerName, cwd) {
    const root = teamStateRoot(cwd, sanitizeName(teamName));
    const workerDir = join(root, 'workers', sanitizeName(workerName));
    await mkdir(workerDir, { recursive: true });
    // Also ensure mailbox dir
    const mailboxDir = join(root, 'mailbox');
    await mkdir(mailboxDir, { recursive: true });
    // And tasks dir
    const tasksDir = join(root, 'tasks');
    await mkdir(tasksDir, { recursive: true });
}
/**
 * Write worker overlay as an AGENTS.md file in the worker state dir.
 * This is separate from the project AGENTS.md — it will be passed to the worker via inbox.
 */
export async function writeWorkerOverlay(params) {
    const { teamName, workerName, cwd } = params;
    const overlay = generateWorkerOverlay(params);
    const overlayPath = join(teamStateRoot(cwd, sanitizeName(teamName)), 'workers', sanitizeName(workerName), 'AGENTS.md');
    await mkdir(dirname(overlayPath), { recursive: true });
    await writeFile(overlayPath, overlay, 'utf-8');
    return overlayPath;
}
//# sourceMappingURL=worker-bootstrap.js.map