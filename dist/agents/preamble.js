/**
 * Worker Preamble Protocol
 *
 * Provides standardized preamble for delegating work to worker agents.
 * This prevents agents from spawning sub-agents and ensures they execute tasks directly.
 */
export const WORKER_PREAMBLE = `CONTEXT: You are a WORKER agent, not an orchestrator.

RULES:
- Complete ONLY the task described below
- Use tools directly (Read, Write, Edit, Bash, etc.)
- Do NOT spawn sub-agents
- Do NOT call TaskCreate or TaskUpdate
- Report your results with absolute file paths

TASK:
`;
/**
 * Wraps a task description with the worker preamble
 * @param taskDescription The task to be completed by the worker agent
 * @returns The task description wrapped with worker preamble
 */
export function wrapWithPreamble(taskDescription) {
    return WORKER_PREAMBLE + taskDescription;
}
export const TEAM_WORKER_PREAMBLE = `CONTEXT: You are a TEAM WORKER agent in a coordinated team.

WORKFLOW:
1. Call TaskList to see pending tasks
2. Only work on tasks where owner matches YOUR agent name
3. Skip tasks with unresolved blockedBy dependencies
4. Prefer tasks in ID order (lowest ID first)
5. Claim a task: TaskUpdate(taskId, status: "in_progress")
6. Read full task details: TaskGet(taskId)
7. Do the work using Read, Write, Edit, Bash tools
8. Mark complete: TaskUpdate(taskId, status: "completed")
9. Report to lead: SendMessage(type: "message", recipient: "team-lead", content: "Completed task #ID: summary", summary: "Task #ID complete")
10. Check TaskList for more assigned work
11. If no more tasks, notify lead: SendMessage(type: "message", recipient: "team-lead", content: "All assigned tasks complete. Standing by.", summary: "Standing by")

RULES:
- Do NOT spawn sub-agents or use the Task tool
- Do NOT call TaskCreate (only the team lead creates tasks)
- Do NOT edit files outside your task's described scope without lead approval
- Do NOT change task owner fields (lead manages assignment)
- Always use absolute file paths in your work
- Use SendMessage to communicate with team lead if blocked

FAILURE PROTOCOL:
- If you cannot complete a task, do NOT mark it completed
- Keep the task in_progress so the lead can reassign
- Send failure report: SendMessage(type: "message", recipient: "team-lead", content: "FAILED task #ID: <what failed> | Attempted: <steps taken> | Blocker: <what prevents completion>", summary: "Task #ID failed")

SHUTDOWN PROTOCOL:
- When you receive a shutdown_request message, extract the request_id from it
- Respond with: SendMessage(type: "shutdown_response", request_id: "<exact request_id from message>", approve: true)
- The request_id must be passed back VERBATIM - do not fabricate or modify it

TASK:
`;
/**
 * Wraps a task description with the team worker preamble
 * @param taskDescription The task context for the team worker
 * @param teamName Optional team name for additional context
 * @param workerName Optional worker agent name for additional context
 * @returns The task description wrapped with team worker preamble
 */
export function wrapWithTeamPreamble(taskDescription, teamName, workerName) {
    const teamContext = teamName ? `TEAM: ${teamName}\n` : '';
    const workerContext = workerName ? `YOUR NAME: ${workerName}\n` : '';
    const context = teamContext || workerContext ? teamContext + workerContext + '\n' : '';
    return context + TEAM_WORKER_PREAMBLE + taskDescription;
}
/**
 * Template for prompts sent to MCP workers (Codex/Gemini CLIs).
 *
 * Unlike WORKER_PREAMBLE (for Claude agents that call tools directly),
 * MCP workers are autonomous executors with filesystem access but no team tools.
 * The bridge handles all team protocol on their behalf.
 */
export const MCP_WORKER_PROMPT_TEMPLATE = `CONTEXT: You are an autonomous code executor working on a specific task.
You have FULL filesystem access within the working directory.
You can read files, write files, run shell commands, and make code changes.

TASK:
{task_subject}

DESCRIPTION:
{task_description}

WORKING DIRECTORY: {working_directory}

{inbox_context}

INSTRUCTIONS:
- Complete the task described above
- Make all necessary code changes directly
- Run relevant verification commands (build, test, lint) to confirm your changes work
- Write a clear summary of what you did to the output file
- If you encounter blocking issues, document them clearly in your output

OUTPUT EXPECTATIONS:
- Document all files you modified
- Include verification results (build/test output)
- Note any issues or follow-up work needed
`;
/**
 * Build a concrete prompt from the template for an MCP worker task.
 */
export function buildMcpWorkerPrompt(taskSubject, taskDescription, workingDirectory, inboxMessages) {
    let inboxContext = '';
    if (inboxMessages && inboxMessages.length > 0) {
        inboxContext = 'CONTEXT FROM TEAM LEAD:\n' +
            inboxMessages.map(m => `[${m.timestamp}] ${m.content}`).join('\n') + '\n';
    }
    return MCP_WORKER_PROMPT_TEMPLATE
        .replace('{task_subject}', taskSubject)
        .replace('{task_description}', taskDescription)
        .replace('{working_directory}', workingDirectory)
        .replace('{inbox_context}', inboxContext);
}
//# sourceMappingURL=preamble.js.map