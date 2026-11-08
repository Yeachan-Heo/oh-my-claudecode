/**
 * Agent Usage Reminder Constants
 *
 * Constants for tracking tool usage and encouraging agent delegation.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */

import { join } from 'path';
import { homedir } from 'os';

/** Storage directory for agent usage reminder state */
export const OMC_STORAGE_DIR = join(homedir(), '.omc');
export const AGENT_USAGE_REMINDER_STORAGE = join(
  OMC_STORAGE_DIR,
  'agent-usage-reminder',
);

/** All tool names normalized to lowercase for case-insensitive matching */
export const TARGET_TOOLS = new Set([
  'grep',
  'safe_grep',
  'glob',
  'safe_glob',
  'webfetch',
  'context7_resolve-library-id',
  'context7_query-docs',
  'websearch_web_search_exa',
  'context7_get-library-docs',
]);

/** Agent tools that indicate agent usage */
export const AGENT_TOOLS = new Set([
  'task',
  'call_omo_agent',
  'omc_task',
]);

/** Reminder message shown to users */
export const REMINDER_MESSAGE = `
[Agent Usage Reminder]

You called a search/fetch tool directly without leveraging specialized agents.

RECOMMENDED: Use Task tool with explore/document-specialist agents for better results:

\`\`\`
// Parallel exploration - fire multiple agents simultaneously
Task(agent="explore", prompt="Find all files matching pattern X")
Task(agent="explore", prompt="Search for implementation of Y")
Task(agent="document-specialist", prompt="Lookup documentation for Z")

// Then continue your work while they run in background
// System will notify you when each completes
\`\`\`

WHY:
- Agents can perform deeper, more thorough searches
- Background tasks run in parallel, saving time
- Specialized agents have domain expertise
- Reduces context window usage in main session

ALWAYS prefer: Multiple parallel Task calls > Direct tool calls
`;
