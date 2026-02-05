/**
 * Worker Preamble Protocol
 *
 * Provides standardized preamble for delegating work to worker agents.
 * This prevents agents from spawning sub-agents and ensures they execute tasks directly.
 *
 * Moved from src/agents/preamble.ts during V4 migration.
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
export function wrapWithPreamble(taskDescription: string): string {
  return WORKER_PREAMBLE + taskDescription;
}
