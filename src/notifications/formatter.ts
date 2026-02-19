/**
 * Notification Message Formatters
 *
 * Produces human-readable notification messages for each event type.
 * Supports markdown (Discord/Telegram) and plain text (Slack/webhook) formats.
 */

import type { NotificationPayload } from "./types.js";
import { basename } from "path";

/**
 * Format duration from milliseconds to human-readable string.
 */
function formatDuration(ms?: number): string {
  if (!ms) return "unknown";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Get project display name from path.
 */
function projectDisplay(payload: NotificationPayload): string {
  if (payload.projectName) return payload.projectName;
  if (payload.projectPath) return basename(payload.projectPath);
  return "unknown";
}

/**
 * Build common footer with tmux and project info.
 */
function buildFooter(payload: NotificationPayload, markdown: boolean): string {
  const parts: string[] = [];

  if (payload.tmuxSession) {
    parts.push(
      markdown
        ? `**tmux:** \`${payload.tmuxSession}\``
        : `tmux: ${payload.tmuxSession}`,
    );
  }

  parts.push(
    markdown
      ? `**project:** \`${projectDisplay(payload)}\``
      : `project: ${projectDisplay(payload)}`,
  );

  return parts.join(markdown ? " | " : " | ");
}

/**
 * Format session-start notification message.
 */
export function formatSessionStart(payload: NotificationPayload): string {
  const time = new Date(payload.timestamp).toLocaleTimeString();
  const project = projectDisplay(payload);

  const lines = [
    `# Session Started`,
    "",
    `**Session:** \`${payload.sessionId}\``,
    `**Project:** \`${project}\``,
    `**Time:** ${time}`,
  ];

  if (payload.tmuxSession) {
    lines.push(`**tmux:** \`${payload.tmuxSession}\``);
  }

  return lines.join("\n");
}

/**
 * Format session-stop notification message.
 * Sent when persistent mode blocks a stop (mode is still active).
 */
export function formatSessionStop(payload: NotificationPayload): string {
  const lines = [`# Session Continuing`, ""];

  if (payload.activeMode) {
    lines.push(`**Mode:** ${payload.activeMode}`);
  }

  if (payload.iteration != null && payload.maxIterations != null) {
    lines.push(`**Iteration:** ${payload.iteration}/${payload.maxIterations}`);
  }

  if (payload.incompleteTasks != null && payload.incompleteTasks > 0) {
    lines.push(`**Incomplete tasks:** ${payload.incompleteTasks}`);
  }

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Format session-end notification message.
 * Full summary with duration, agents, modes, and context.
 */
export function formatSessionEnd(payload: NotificationPayload): string {
  const duration = formatDuration(payload.durationMs);

  const lines = [
    `# Session Ended`,
    "",
    `**Session:** \`${payload.sessionId}\``,
    `**Duration:** ${duration}`,
    `**Reason:** ${payload.reason || "unknown"}`,
  ];

  if (payload.agentsSpawned != null) {
    lines.push(
      `**Agents:** ${payload.agentsCompleted ?? 0}/${payload.agentsSpawned} completed`,
    );
  }

  if (payload.modesUsed && payload.modesUsed.length > 0) {
    lines.push(`**Modes:** ${payload.modesUsed.join(", ")}`);
  }

  if (payload.contextSummary) {
    lines.push("", `**Summary:** ${payload.contextSummary}`);
  }

  appendTmuxTail(lines, payload);

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Format session-idle notification message.
 * Sent when Claude stops and no persistent mode is blocking (truly idle).
 */
export function formatSessionIdle(payload: NotificationPayload): string {
  const lines = [`# Session Idle`, ""];

  lines.push(`Claude has finished and is waiting for input.`);
  lines.push("");

  if (payload.reason) {
    lines.push(`**Reason:** ${payload.reason}`);
  }

  if (payload.modesUsed && payload.modesUsed.length > 0) {
    lines.push(`**Modes:** ${payload.modesUsed.join(", ")}`);
  }

  appendTmuxTail(lines, payload);

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Append tmux tail content to a message if present in the payload.
 */
function appendTmuxTail(lines: string[], payload: NotificationPayload): void {
  if (payload.tmuxTail) {
    lines.push("");
    lines.push("**Recent output:**");
    lines.push("```");
    lines.push(payload.tmuxTail.trimEnd());
    lines.push("```");
  }
}

/**
 * Format agent-call notification message.
 * Sent when a new agent (Task) is spawned.
 */
export function formatAgentCall(payload: NotificationPayload): string {
  const lines = [`# Agent Spawned`, ""];

  if (payload.agentName) {
    lines.push(`**Agent:** \`${payload.agentName}\``);
  }

  if (payload.agentType) {
    lines.push(`**Type:** \`${payload.agentType}\``);
  }

  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Format ask-user-question notification message.
 * Notifies the user that Claude is waiting for input.
 */
export function formatAskUserQuestion(payload: NotificationPayload): string {
  const lines = [`# Input Needed`, ""];

  if (payload.question) {
    lines.push(`**Question:** ${payload.question}`);
    lines.push("");
  }

  lines.push(`Claude is waiting for your response.`);
  lines.push("");
  lines.push(buildFooter(payload, true));

  return lines.join("\n");
}

/**
 * Format notification message based on event type.
 * Returns a markdown-formatted string suitable for Discord/Telegram.
 */
export function formatNotification(payload: NotificationPayload): string {
  switch (payload.event) {
    case "session-start":
      return formatSessionStart(payload);
    case "session-stop":
      return formatSessionStop(payload);
    case "session-end":
      return formatSessionEnd(payload);
    case "session-idle":
      return formatSessionIdle(payload);
    case "ask-user-question":
      return formatAskUserQuestion(payload);
    case "agent-call":
      return formatAgentCall(payload);
    default:
      return payload.message || `Event: ${payload.event}`;
  }
}
