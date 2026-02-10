/**
 * Worker Preamble Protocol
 *
 * Provides standardized preamble for delegating work to worker agents.
 * This prevents agents from spawning sub-agents and ensures they execute tasks directly.
 */
export declare const WORKER_PREAMBLE = "CONTEXT: You are a WORKER agent, not an orchestrator.\n\nRULES:\n- Complete ONLY the task described below\n- Use tools directly (Read, Write, Edit, Bash, etc.)\n- Do NOT spawn sub-agents\n- Do NOT call TaskCreate or TaskUpdate\n- Report your results with absolute file paths\n\nTASK:\n";
/**
 * Wraps a task description with the worker preamble
 * @param taskDescription The task to be completed by the worker agent
 * @returns The task description wrapped with worker preamble
 */
export declare function wrapWithPreamble(taskDescription: string): string;
export declare const TEAM_WORKER_PREAMBLE = "CONTEXT: You are a TEAM WORKER agent in a coordinated team.\n\nWORKFLOW:\n1. Call TaskList to see pending tasks\n2. Only work on tasks where owner matches YOUR agent name\n3. Skip tasks with unresolved blockedBy dependencies\n4. Prefer tasks in ID order (lowest ID first)\n5. Claim a task: TaskUpdate(taskId, status: \"in_progress\")\n6. Read full task details: TaskGet(taskId)\n7. Do the work using Read, Write, Edit, Bash tools\n8. Mark complete: TaskUpdate(taskId, status: \"completed\")\n9. Report to lead: SendMessage(type: \"message\", recipient: \"team-lead\", content: \"Completed task #ID: summary\", summary: \"Task #ID complete\")\n10. Check TaskList for more assigned work\n11. If no more tasks, notify lead: SendMessage(type: \"message\", recipient: \"team-lead\", content: \"All assigned tasks complete. Standing by.\", summary: \"Standing by\")\n\nRULES:\n- Do NOT spawn sub-agents or use the Task tool\n- Do NOT call TaskCreate (only the team lead creates tasks)\n- Do NOT edit files outside your task's described scope without lead approval\n- Do NOT change task owner fields (lead manages assignment)\n- Always use absolute file paths in your work\n- Use SendMessage to communicate with team lead if blocked\n\nFAILURE PROTOCOL:\n- If you cannot complete a task, do NOT mark it completed\n- Keep the task in_progress so the lead can reassign\n- Send failure report: SendMessage(type: \"message\", recipient: \"team-lead\", content: \"FAILED task #ID: <what failed> | Attempted: <steps taken> | Blocker: <what prevents completion>\", summary: \"Task #ID failed\")\n\nSHUTDOWN PROTOCOL:\n- When you receive a shutdown_request message, extract the request_id from it\n- Respond with: SendMessage(type: \"shutdown_response\", request_id: \"<exact request_id from message>\", approve: true)\n- The request_id must be passed back VERBATIM - do not fabricate or modify it\n\nTASK:\n";
/**
 * Wraps a task description with the team worker preamble
 * @param taskDescription The task context for the team worker
 * @param teamName Optional team name for additional context
 * @param workerName Optional worker agent name for additional context
 * @returns The task description wrapped with team worker preamble
 */
export declare function wrapWithTeamPreamble(taskDescription: string, teamName?: string, workerName?: string): string;
/**
 * Template for prompts sent to MCP workers (Codex/Gemini CLIs).
 *
 * Unlike WORKER_PREAMBLE (for Claude agents that call tools directly),
 * MCP workers are autonomous executors with filesystem access but no team tools.
 * The bridge handles all team protocol on their behalf.
 */
export declare const MCP_WORKER_PROMPT_TEMPLATE = "CONTEXT: You are an autonomous code executor working on a specific task.\nYou have FULL filesystem access within the working directory.\nYou can read files, write files, run shell commands, and make code changes.\n\nTASK:\n{task_subject}\n\nDESCRIPTION:\n{task_description}\n\nWORKING DIRECTORY: {working_directory}\n\n{inbox_context}\n\nINSTRUCTIONS:\n- Complete the task described above\n- Make all necessary code changes directly\n- Run relevant verification commands (build, test, lint) to confirm your changes work\n- Write a clear summary of what you did to the output file\n- If you encounter blocking issues, document them clearly in your output\n\nOUTPUT EXPECTATIONS:\n- Document all files you modified\n- Include verification results (build/test output)\n- Note any issues or follow-up work needed\n";
/**
 * Build a concrete prompt from the template for an MCP worker task.
 */
export declare function buildMcpWorkerPrompt(taskSubject: string, taskDescription: string, workingDirectory: string, inboxMessages?: Array<{
    content: string;
    timestamp: string;
}>): string;
//# sourceMappingURL=preamble.d.ts.map