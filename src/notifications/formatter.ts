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

/** Matches ANSI escape sequences (CSI and two-character escapes). */
const ANSI_ESCAPE_RE = /\x1b(?:[@-Z\\-_]|\[[0-9;]*[a-zA-Z])/g;

/** Lines starting with these characters are OMC UI chrome, not output. */
const UI_CHROME_RE = /^[●⎿✻·◼]/;

/** Matches the "ctrl+o to expand" hint injected by OMC. */
const CTRL_O_RE = /ctrl\+o to expand/i;

/** Lines composed entirely of box-drawing characters and whitespace. */
const BOX_DRAWING_RE = /^[\s─═│║┌┐└┘┬┴├┤╔╗╚╝╠╣╦╩╬╟╢╤╧╪━┃┏┓┗┛┣┫┳┻╋┠┨┯┷┿╂]+$/;

/** OMC HUD status lines: [OMC#...] or [OMC] (unversioned). */
const OMC_HUD_RE = /\[OMC[#\]]/;

/** Bypass-permissions indicator lines starting with ⏵. */
const BYPASS_PERM_RE = /^⏵/;

/** Bare shell prompt with no command after it. */
const BARE_PROMPT_RE = /^[❯>$%#]+$/;

/** Minimum ratio of alphanumeric characters for a line to be "meaningful". */
const MIN_ALNUM_RATIO = 0.15;

/** Maximum number of meaningful lines to include in a notification. */
const MAX_TAIL_LINES = 10;

/**
 * Parse raw tmux output into clean, human-readable lines.
 * - Strips ANSI escape codes
 * - Drops lines starting with OMC chrome characters (●, ⎿, ✻, ·, ◼)
 * - Drops "ctrl+o to expand" hint lines
 * - Returns at most 10 non-empty lines
 */
export function parseTmuxTail(raw: string): string {
  const meaningful: string[] = [];

  for (const line of raw.split("\n")) {
    const stripped = line.replace(ANSI_ESCAPE_RE, "");
    const trimmed = stripped.trim();

    if (!trimmed) continue;
    if (UI_CHROME_RE.test(trimmed)) continue;
    if (CTRL_O_RE.test(trimmed)) continue;
    if (BOX_DRAWING_RE.test(trimmed)) continue;
    if (OMC_HUD_RE.test(trimmed)) continue;
    if (BYPASS_PERM_RE.test(trimmed)) continue;
    if (BARE_PROMPT_RE.test(trimmed)) continue;

    // Alphanumeric density check: drop lines mostly composed of special characters
    const alnumCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
    if (trimmed.length >= 8 && alnumCount / trimmed.length < MIN_ALNUM_RATIO) continue;

    meaningful.push(stripped.trimEnd());
  }

  return meaningful.slice(-MAX_TAIL_LINES).join("\n");
}

/**
 * Append tmux tail content to a message if present in the payload.
 */
function appendTmuxTail(lines: string[], payload: NotificationPayload): void {
  if (payload.tmuxTail) {
    const parsed = parseTmuxTail(payload.tmuxTail);
    if (parsed) {
      lines.push("");
      lines.push("**Recent output:**");
      lines.push("```");
      lines.push(parsed);
      lines.push("```");
    }
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
