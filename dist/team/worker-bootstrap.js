import { mkdir, writeFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { sanitizePromptContent } from '../agents/prompt-helpers.js';
function agentTypeGuidance(agentType) {
    switch (agentType) {
        case 'codex':
            return [
                '### Agent-Type Guidance (codex)',
                '- Prefer short, explicit `omc team api ... --json` commands and parse outputs before next step.',
                '- If a command fails, report the exact stderr to leader-fixed before retrying.',
            ].join('\n');
        case 'gemini':
            return [
                '### Agent-Type Guidance (gemini)',
                '- Execute task work in small, verifiable increments and report each milestone to leader-fixed.',
                '- Keep commit-sized changes scoped to assigned files only; no broad refactors.',
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
    const { teamName, workerName, agentType, tasks, bootstrapInstructions } = params;
    // Sanitize all task content before embedding
    const sanitizedTasks = tasks.map(t => ({
        id: t.id,
        subject: sanitizePromptContent(t.subject),
        description: sanitizePromptContent(t.description),
    }));
    const sentinelPath = `.omc/state/team/${teamName}/workers/${workerName}/.ready`;
    const heartbeatPath = `.omc/state/team/${teamName}/workers/${workerName}/heartbeat.json`;
    const inboxPath = `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`;
    const statusPath = `.omc/state/team/${teamName}/workers/${workerName}/status.json`;
    const taskDir = `.omc/state/team/${teamName}/tasks`;
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

## Identity
- **Team**: ${teamName}
- **Worker**: ${workerName}
- **Agent Type**: ${agentType}
- **Environment**: OMC_TEAM_WORKER=${teamName}/${workerName}

## Your Tasks
${taskList}

## Task Lifecycle Protocol (CLI API)
Use the CLI API for all task lifecycle operations. Do NOT directly edit task files.

1. Read your task file at \`${taskDir}/task-{taskId}.json\`
2. Task id format: State/CLI APIs use task_id: "<id>" (example: "1"), not "task-1"
3. Claim a task via CLI interop:
   \`omc team api claim-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName}\\"}" --json\`
4. Do the work described in the task
5. On completion, transition via CLI interop (use the claim_token from step 3):
   \`omc team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"completed\\",\\"claim_token\\":\\"<claim_token from step 3>\\"}" --json\`
6. On failure, transition to "failed" with error (use the claim_token from step 3):
   \`omc team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"failed\\",\\"claim_token\\":\\"<claim_token from step 3>\\"}" --json\`
7. Use \`omc team api release-task-claim --json\` only for rollback to pending

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
- To leader: \`omc team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"<message>\\"}" --json\`
- Check mailbox: \`omc team api mailbox-list --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\"}" --json\`
- Mark delivered: \`omc team api mailbox-mark-delivered --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\",\\"message_id\\":\\"<id>\\"}" --json\`

## Startup Handshake (Required)
Before doing any task work, send exactly one startup ACK to the leader:
\`omc team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"ACK: ${workerName} initialized\\"}" --json\`

## Shutdown Protocol
When you see a shutdown request in your inbox:
1. Write your decision to: .omc/state/team/${teamName}/workers/${workerName}/shutdown-ack.json
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
- Do NOT run team spawning/orchestration commands (for example: \`omc team ...\`, \`omx team ...\`, \`$team\`, \`$ultrawork\`, \`$autopilot\`, \`$ralph\`).
- Worker-allowed control surface is only: \`omc team api ... --json\` (and equivalent \`omx team api ... --json\` where configured).
- If blocked, write {"state": "blocked", "reason": "..."} to your status file

${agentTypeGuidance(agentType)}

${bootstrapInstructions ? `## Additional Instructions\n${bootstrapInstructions}\n` : ''}`;
}
/**
 * Write the initial inbox file for a worker.
 */
export async function composeInitialInbox(teamName, workerName, content, cwd) {
    const inboxPath = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`);
    await mkdir(dirname(inboxPath), { recursive: true });
    await writeFile(inboxPath, content, 'utf-8');
}
/**
 * Append a message to the worker inbox.
 */
export async function appendToInbox(teamName, workerName, message, cwd) {
    const inboxPath = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`);
    await mkdir(dirname(inboxPath), { recursive: true });
    await appendFile(inboxPath, `\n\n---\n${message}`, 'utf-8');
}
// Re-export from model-contract (single source of truth)
export { getWorkerEnv } from './model-contract.js';
/**
 * Ensure worker state directory exists.
 */
export async function ensureWorkerStateDir(teamName, workerName, cwd) {
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
export async function writeWorkerOverlay(params) {
    const { teamName, workerName, cwd } = params;
    const overlay = generateWorkerOverlay(params);
    const overlayPath = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}/AGENTS.md`);
    await mkdir(dirname(overlayPath), { recursive: true });
    await writeFile(overlayPath, overlay, 'utf-8');
    return overlayPath;
}
//# sourceMappingURL=worker-bootstrap.js.map