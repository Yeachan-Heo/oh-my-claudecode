import { mkdir, writeFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { sanitizePromptContent } from '../agents/prompt-helpers.js';
import { formatOmcCliInvocation } from '../utils/omc-cli-rendering.js';
import type { CliAgentType } from './model-contract.js';
import { sanitizeName } from './tmux-session.js';
import { validateResolvedPath } from './fs-utils.js';

export interface WorkerBootstrapParams {
  teamName: string;
  workerName: string;
  agentType: CliAgentType;
  tasks: Array<{ id: string; subject: string; description: string; }>;
  bootstrapInstructions?: string;
  cwd: string;
  /**
   * Worker-facing root used in instructions. The default is the leader cwd
   * relative global state root (`.omc/state`); non-default values are treated as
   * a team-specific root (`.../.omc/state/team/<team>`), matching
   * `OMC_TEAM_STATE_ROOT` and `teamStateRoot()` semantics.
   */
  instructionStateRoot?: string;
}

const DEFAULT_INSTRUCTION_STATE_ROOT = '.omc/state';

function buildInstructionPath(...parts: string[]): string {
  return join(...parts).replaceAll('\\', '/');
}

function buildTeamStateInstructionPath(
  teamName: string,
  instructionStateRoot: string,
  ...teamRelativeParts: string[]
): string {
  const baseParts = instructionStateRoot === DEFAULT_INSTRUCTION_STATE_ROOT
    ? [instructionStateRoot, 'team', teamName]
    : [instructionStateRoot];
  return buildInstructionPath(...baseParts, ...teamRelativeParts);
}

export function generateTriggerMessage(
  teamName: string,
  workerName: string,
  teamStateRoot = DEFAULT_INSTRUCTION_STATE_ROOT,
): string {
  const inboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot, 'workers', workerName, 'inbox.md');
  if (teamStateRoot !== DEFAULT_INSTRUCTION_STATE_ROOT) {
    return `Read ${inboxPath}, work now, report progress.`;
  }
  return `Read ${inboxPath}, execute now, report concrete progress.`;
}

export function generatePromptModeStartupPrompt(
  teamName: string,
  workerName: string,
  teamStateRoot = DEFAULT_INSTRUCTION_STATE_ROOT,
  cliOutputContract?: string,
): string {
  const inboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot, 'workers', workerName, 'inbox.md');
  const base = `Open ${inboxPath}. Follow it and begin the assigned work.`;
  return cliOutputContract ? `${base}\n${cliOutputContract}` : base;
}

export function generateMailboxTriggerMessage(
  teamName: string,
  workerName: string,
  count = 1,
  teamStateRoot = DEFAULT_INSTRUCTION_STATE_ROOT,
): string {
  const normalizedCount = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const mailboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot, 'mailbox', `${workerName}.json`);
  if (teamStateRoot !== DEFAULT_INSTRUCTION_STATE_ROOT) {
    return `${normalizedCount} new msg(s): check ${mailboxPath}, act and report progress.`;
  }
  return `${normalizedCount} new msg(s). Read ${mailboxPath}, act now, report concrete progress.`;
}

function agentTypeGuidance(agentType: CliAgentType): string {
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
      return [
        '### Agent-Type Guidance (cursor)',
        '- You are an interactive REPL (cursor-agent), not a one-shot CLI. Stay in the session; the leader will continue to send prompts via mailbox.',
        `- You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done. Then keep waiting for the next mailbox message; do NOT type \`/exit\` unless the leader sends an explicit shutdown.`,
        '- Reviewer/critic/security-review roles are NOT supported for cursor workers — those require a verdict-file write-and-exit which the REPL does not perform. Take only executor-style tasks.',
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
export function generateWorkerOverlay(params: WorkerBootstrapParams): string {
  const { teamName, workerName, agentType, tasks, bootstrapInstructions } = params;
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
  const claimTaskCommand = formatOmcCliInvocation(`team api claim-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const sendAckCommand = formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"ACK: ${workerName} initialized\\"}" --json`);
  const completeTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"completed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
  const failTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"failed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
  const readTaskCommand = formatOmcCliInvocation(`team api read-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\"}" --json`);
  const releaseClaimCommand = formatOmcCliInvocation(`team api release-task-claim --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"claim_token\\":\\"<claim_token>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const mailboxListCommand = formatOmcCliInvocation(`team api mailbox-list --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const mailboxDeliveredCommand = formatOmcCliInvocation(`team api mailbox-mark-delivered --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\",\\"message_id\\":\\"<id>\\"}" --json`);
  const teamApiCommand = formatOmcCliInvocation('team api');
  const teamCommand = formatOmcCliInvocation('team');

  const taskList = sanitizedTasks.length > 0
    ? sanitizedTasks.map(t => `- **Task ${t.id}**: ${t.subject}\n  Description: ${t.description}\n  Status: pending`).join('\n')
    : '- No tasks assigned yet. Check your inbox for assignments.';

  return `# Team Worker Protocol

You are a **team worker**, not the team leader. Operate strictly within worker protocol.

## FIRST ACTION REQUIRED
Before doing anything else, write your ready sentinel file:
\`\`\`bash
mkdir -p $(dirname ${sentinelPath}) && touch ${sentinelPath}
\`\`\`

## MANDATORY WORKFLOW — Follow These Steps In Order
You MUST complete ALL of these steps. Do NOT skip any step. Do NOT exit without step 4.

1. **Claim** your task (run this command first):
   \`${claimTaskCommand}\`
   Save the \`claim_token\` from the response — you need it for step 4.
2. **Do the work** described in your task assignment below.
3. **Send ACK** to the leader:
   \`${sendAckCommand}\`
4. **Transition** the task status (REQUIRED before exit):
   - On success: \`${completeTaskCommand}\`
   - On failure: \`${failTaskCommand}\`
5. **Keep going after replies**: ACK/progress messages are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.

## Identity
- **Team**: ${teamName}
- **Worker**: ${workerName}
- **Agent Type**: ${agentType}
- **Environment**: OMC_TEAM_WORKER=${teamName}/${workerName}

## Your Tasks
${taskList}

## Task Lifecycle Reference (CLI API)
Use the CLI API for all task lifecycle operations. Do NOT directly edit task files.

- Inspect task state: \`${readTaskCommand}\`
- Task id format: State/CLI APIs use task_id: "<id>" (example: "1"), not "task-1"
- Claim task: \`${claimTaskCommand}\`
- Complete task: \`${completeTaskCommand}\`
- Fail task: \`${failTaskCommand}\`
- Release claim (rollback): \`${releaseClaimCommand}\`

## Canonical Team State Root
- Resolve the team state root in this order: \`OMC_TEAM_STATE_ROOT\` env -> worker identity \`team_state_root\` -> config/manifest \`team_state_root\` -> ${params.cwd}/.omc/state/team/${teamName}.
- \`OMC_TEAM_STATE_ROOT\` is the team-specific root (\`.../.omc/state/team/${teamName}\`). When it is set, append worker/mailbox paths directly below it; do not append another \`team/${teamName}\` segment.
- Worktree-backed workers MUST use the canonical leader-owned state root for inbox, mailbox, task lifecycle, status, heartbeat, and shutdown files; do not use a local worktree \`.omc/state\` when \`OMC_TEAM_STATE_ROOT\` is set.

## Communication Protocol
- **Inbox**: Read ${inboxPath} for new instructions
- **Status**: Write to ${statusPath}:
  \`\`\`json
  {"state": "idle", "updated_at": "<ISO timestamp>"}
  \`\`\`
  States: "idle" | "working" | "blocked" | "done" | "failed"
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
- Do NOT run team spawning/orchestration commands (for example: \`${teamCommand} ...\`, \`omx team ...\`, \`$team\`, \`$ultrawork\`, \`$autopilot\`, \`$ralph\`).
- Worker-allowed control surface is only: \`${teamApiCommand} ... --json\` (and equivalent \`omx team api ... --json\` where configured).
- If blocked, write {"state": "blocked", "reason": "..."} to your status file

${agentTypeGuidance(agentType)}

## BEFORE YOU EXIT
You MUST call \`${formatOmcCliInvocation('team api transition-task-status')}\` to mark your task as "completed" or "failed" before exiting.
If you skip this step, the leader cannot track your work and the task will appear stuck.

${bootstrapInstructions ? `## Role Context\n${bootstrapInstructions}\n` : ''}`;
}

/**
 * Write the initial inbox file for a worker.
 */
export async function composeInitialInbox(
  teamName: string,
  workerName: string,
  content: string,
  cwd: string,
  cliOutputContract?: string,
): Promise<void> {
  const inboxPath = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`);
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
export async function appendToInbox(
  teamName: string,
  workerName: string,
  message: string,
  cwd: string
): Promise<void> {
  const safeTeam = sanitizeName(teamName);
  const safeWorker = sanitizeName(workerName);
  const inboxPath = join(cwd, `.omc/state/team/${safeTeam}/workers/${safeWorker}/inbox.md`);
  validateResolvedPath(inboxPath, cwd);
  await mkdir(dirname(inboxPath), { recursive: true });
  await appendFile(inboxPath, `\n\n---\n${message}`, 'utf-8');
}

// Re-export from model-contract (single source of truth)
export { getWorkerEnv } from './model-contract.js';

/**
 * Ensure worker state directory exists.
 */
export async function ensureWorkerStateDir(
  teamName: string,
  workerName: string,
  cwd: string
): Promise<void> {
  const workerDir = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}`);
  await mkdir(workerDir, { recursive: true });

  // Also ensure mailbox dir
  const mailboxDir = join(cwd, `.omc/state/team/${teamName}/mailbox`);
  await mkdir(mailboxDir, { recursive: true });

  // And tasks dir
  const tasksDir = join(cwd, `.omc/state/team/${teamName}/tasks`);
  await mkdir(tasksDir, { recursive: true });
}

/**
 * Write worker overlay as an AGENTS.md file in the worker state dir.
 * This is separate from the project AGENTS.md — it will be passed to the worker via inbox.
 */
export async function writeWorkerOverlay(
  params: WorkerBootstrapParams
): Promise<string> {
  const { teamName, workerName, cwd } = params;
  const overlay = generateWorkerOverlay(params);
  const overlayPath = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}/AGENTS.md`);
  await mkdir(dirname(overlayPath), { recursive: true });
  await writeFile(overlayPath, overlay, 'utf-8');
  return overlayPath;
}
