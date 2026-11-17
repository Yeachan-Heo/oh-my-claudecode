/**
 * Agent Usage Reminder Constants
 *
 * Constants for tracking tool usage and encouraging agent delegation.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */
/** Storage directory for agent usage reminder state */
export declare const OMC_STORAGE_DIR: string;
export declare const AGENT_USAGE_REMINDER_STORAGE: string;
/** All tool names normalized to lowercase for case-insensitive matching */
export declare const TARGET_TOOLS: Set<string>;
/** Agent tools that indicate agent usage */
export declare const AGENT_TOOLS: Set<string>;
/** Reminder message shown to users */
export declare const REMINDER_MESSAGE = "\n[Agent Usage Reminder]\n\nYou called a search/fetch tool directly without leveraging specialized agents.\n\nRECOMMENDED: Use Task tool with explore/document-specialist agents for better results:\n\n```\n// Parallel exploration - fire multiple agents simultaneously\nTask(agent=\"explore\", prompt=\"Find all files matching pattern X\")\nTask(agent=\"explore\", prompt=\"Search for implementation of Y\")\nTask(agent=\"document-specialist\", prompt=\"Lookup documentation for Z\")\n\n// Then continue your work while they run in background\n// System will notify you when each completes\n```\n\nWHY:\n- Agents can perform deeper, more thorough searches\n- Background tasks run in parallel, saving time\n- Specialized agents have domain expertise\n- Reduces context window usage in main session\n\nALWAYS prefer: Multiple parallel Task calls > Direct tool calls\n";
//# sourceMappingURL=constants.d.ts.map