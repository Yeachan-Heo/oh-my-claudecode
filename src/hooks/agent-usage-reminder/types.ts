/**
 * Agent Usage Reminder Types
 *
 * Tracks agent usage to encourage delegation to specialized agents.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */

export interface AgentUsageState {
  sessionID: string;
  agentUsed: boolean;
  reminderCount: number;
  updatedAt: number;
}
