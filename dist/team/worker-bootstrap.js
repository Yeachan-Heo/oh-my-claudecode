import { mkdir, writeFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { sanitizePromptContent } from '../agents/prompt-helpers.js';
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
    const taskDir = `.omc/state/team/${teamName}/tasks`;
    const donePath = `.omc/state/team/${teamName}/workers/${workerName}/done.json`;
    const taskList = sanitizedTasks.length > 0
        ? sanitizedTasks.map(t => `- **Task ${t.id}**: ${t.subject}`).join('\n')
        : '- No tasks assigned yet. Check your inbox for assignments.';
    return `# Team Worker Protocol

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

## Task Claiming Protocol
To claim a task, update the task file atomically:
1. Read task from: ${taskDir}/{taskId}.json
2. Update status to "in_progress", set owner to "${workerName}"
3. Write back to task file
4. Do the work
5. Update status to "completed", write result to task file

## Communication Protocol
- **Inbox**: Read ${inboxPath} for new instructions
- **Heartbeat**: Update ${heartbeatPath} every few minutes:
  \`\`\`json
  {"workerName":"${workerName}","status":"working","updatedAt":"<ISO timestamp>","currentTaskId":"<id or null>"}
  \`\`\`

## Task Completion Protocol
When you finish a task (success or failure), write a done signal file:
- Path: ${donePath}
- Content (JSON, one line):
  {"taskId":"<id>","status":"completed","summary":"<1-2 sentence summary>","completedAt":"<ISO timestamp>"}
- For failures, set status to "failed" and include the error in summary.
- Use "completed" or "failed" only for status.

## Shutdown Protocol
When you see a shutdown request (check .omc/state/team/${teamName}/shutdown.json):
1. Finish your current task if close to completion
2. Write an ACK file: .omc/state/team/${teamName}/workers/${workerName}/shutdown-ack.json
3. Exit

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