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

/** Review-session seed prompt outcome keywords that cause tmux alert noise. */
const REVIEW_SEED_OUTCOME_PATTERNS = [
  { key: "approve", pattern: /\bapprove\b/i },
  { key: "request-changes", pattern: /\brequest[- ]changes\b/i },
  { key: "follow-up-fix", pattern: /\bfollow[- ]up[- ]fix\b/i },
  { key: "blocked", pattern: /\bblocked\b/i },
  { key: "error", pattern: /\berrors?\b/i },
  { key: "failure", pattern: /\bfail(?:ed|ure|ures)?\b/i },
  { key: "conflict", pattern: /\bconflicts?\b/i },
] as const;

/** Instructional phrasing commonly found in seeded review prompts. */
const REVIEW_SEED_CUE_RE =
  /\b(review|verdict|respond|reply|return|output|classification|classify|decision|choose|label)\b/i;

/** Continuation markers for bullets / enumerated option lines in seeded prompts. */
const REVIEW_SEED_LIST_RE = /^(?:[-*•]|\d+[.)]|[A-Z][A-Z_-]+:|\([a-z0-9]+\))/;

/** Static source/grep output lines that often trip keyword alerts without representing runtime failure. */
const SOURCE_PATH_LINE_RE = /^(?:\.\/)?[A-Za-z0-9_./-]+:\d+:/;
const STATIC_CODE_ALERT_RE = /(?:\blog_error\b|\becho\b).*?(?:"error\||"Usage:)|==\s*"error"/;
const HELP_USAGE_LINE_RE = /^(?:Usage|Examples?|Commands?|Options?|Flags?):/i;
const STATIC_HELP_CODE_RE = /^(?:log_error\s+"Usage:|if\s+\[\[.*==\s*"error".*\]\];?\s*then$)/;
const DIFF_HEADER_LINE_RE = /^(?:diff --git\b|index\s+[0-9a-f]{6,}\.\.[0-9a-f]{6,}\b|@@\s+[-+]\d|---\s+\S|\+\+\+\s+\S)/i;
const STRUCTURED_ALERT_KEYWORD_RE =
  /\b(?:error|errors?|fail(?:ed|ure|ures)?|conflict|conflicts|operation_failed|claim_conflict|invalid_transition|blocked_dependency|worker_notify_failed)\b/i;
const SEARCH_COMMAND_RE = /^(?:[$❯>#]\s*)?(?:rg|ripgrep|grep|egrep|fgrep)\b/i;
const QUOTED_OR_REGEX_QUERY_RE = /(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\/[^/\n]+\/[a-z]*)/i;
const ZERO_ALERT_SUMMARY_RE =
  /\b(?:0|zero)\s+(?:errors?|fail(?:ed|ures?)?|conflicts?)\b|\b(?:errors?|fail(?:ed|ures?)?|conflicts?)\s*[:=]\s*0\b|\btotalErrors\s*[:=]\s*0\b|\b(?:TypeScript|LSP)\s+check\s+passed:\s*0 errors,\s*0 warnings\b/i;
const ALERT_REGEX_LITERAL_RE =
  /(?:^|[=(:,]\s*)(?:new\s+RegExp\(|\/)(?=[^)\n;]*\b(?:error|errors?|fail(?:ed|ure|ures)?|conflict|conflicts|operation_failed|claim_conflict|invalid_transition|blocked_dependency|worker_notify_failed)\b)/i;
const GENERIC_HOOK_FAILURE_PROSE_RE =
  /^The Bash output indicates (?:a )?(?:command\/setup|command|setup) failure\b/i;
const ISSUE_PROMPT_NOISE_RE =
  /^(?:fix|review|investigate|analyze|search|find|look\s+for|debug|harden)\b.*\b(?:issue|pr)\s*#\d+\b.*\b(?:error|errors?|fail(?:ed|ure|ures)?|conflict|conflicts)\b/i;
const JSONISH_LINE_RE =
  /^(?:[{[]|"(?:[^"\\]|\\.)+"\s*:|'(?:[^'\\]|\\.)+'\s*:)/;
const REQUEST_RESPONSE_LITERAL_RE =
  /^(?:payload|request|response|input|output|args|params|body|mcp)\s*[:=]\s*[{[]/i;
const CODE_LITERAL_PREFIX_RE =
  /^(?:[+-]\s*(?:[{[]|"(?:[^"\\]|\\.)+"\s*:|'(?:[^'\\]|\\.)+'\s*:|(?:const|let|var|return|throw|if|await|expect|mock|vi\.)\b|[A-Za-z_$][\w$-]*\s*:)|(?:const|let|var|return|throw|if|await|expect|mock|vi\.)\b)/;

/** Default maximum number of meaningful lines to include in a notification.
 * Matches DEFAULT_TMUX_TAIL_LINES in config.ts. */
const DEFAULT_MAX_TAIL_LINES = 15;

function extractReviewSeedOutcomeKeys(line: string): string[] {
  return REVIEW_SEED_OUTCOME_PATTERNS
    .filter(({ pattern }) => pattern.test(line))
    .map(({ key }) => key);
}

function trimReviewSeedPrefix(lines: string[]): string[] {
  if (lines.length === 0) return lines;

  const prefix = lines.slice(0, 10);
  const distinctOutcomes = new Set<string>();
  let hasCue = false;
  let hasListMarker = false;
  let candidateEnd = -1;

  for (let index = 0; index < prefix.length; index += 1) {
    const line = prefix[index]!;
    const outcomeKeys = extractReviewSeedOutcomeKeys(line);
    const isCueLine = REVIEW_SEED_CUE_RE.test(line);
    const isSeedLine =
      outcomeKeys.length > 0 ||
      isCueLine ||
      (candidateEnd >= 0 && REVIEW_SEED_LIST_RE.test(line));

    outcomeKeys.forEach((key) => distinctOutcomes.add(key));
    if (isCueLine) hasCue = true;
    if (REVIEW_SEED_LIST_RE.test(line)) hasListMarker = true;
    if (isSeedLine) {
      candidateEnd = index;
      continue;
    }
    if (candidateEnd >= 0) break;
  }

  const qualifies =
    candidateEnd >= 0 &&
    hasCue &&
    (distinctOutcomes.size >= 2 || hasListMarker);

  if (!qualifies) return lines;
  return lines.slice(candidateEnd + 1);
}

function looksLikeStructuredAlertLiteral(line: string): boolean {
  const trimmed = line.trim();
  if (!STRUCTURED_ALERT_KEYWORD_RE.test(trimmed)) return false;
  if (/^(?:\{.*\}|\[.*\])$/.test(trimmed) && /["'{\[\]}:,]/.test(trimmed)) return true;
  if (JSONISH_LINE_RE.test(trimmed)) return true;
  if (CODE_LITERAL_PREFIX_RE.test(trimmed) && /["'`{}[\]()=>]/.test(trimmed)) return true;
  return false;
}

function looksLikeAlertSearchCommand(line: string): boolean {
  const trimmed = line.trim();
  return (
    SEARCH_COMMAND_RE.test(trimmed) &&
    STRUCTURED_ALERT_KEYWORD_RE.test(trimmed) &&
    (QUOTED_OR_REGEX_QUERY_RE.test(trimmed) || trimmed.includes("|"))
  );
}

function looksLikeAlertRegexLiteral(line: string): boolean {
  const trimmed = line.trim();
  return STRUCTURED_ALERT_KEYWORD_RE.test(trimmed) && ALERT_REGEX_LITERAL_RE.test(trimmed);
}

/**
 * Parse raw tmux output into clean, human-readable lines.
 * - Strips ANSI escape codes
 * - Drops lines starting with OMC chrome characters (●, ⎿, ✻, ·, ◼)
 * - Drops "ctrl+o to expand" hint lines
 * - Returns at most `maxLines` non-empty lines (default 10)
 */
export function parseTmuxTail(raw: string, maxLines: number = DEFAULT_MAX_TAIL_LINES): string {
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
    if (DIFF_HEADER_LINE_RE.test(trimmed)) continue;
    if (looksLikeAlertSearchCommand(trimmed)) continue;
    if (REQUEST_RESPONSE_LITERAL_RE.test(trimmed)) continue;
    if (HELP_USAGE_LINE_RE.test(trimmed)) continue;
    if (STATIC_HELP_CODE_RE.test(trimmed)) continue;
    if (ZERO_ALERT_SUMMARY_RE.test(trimmed)) continue;
    if (GENERIC_HOOK_FAILURE_PROSE_RE.test(trimmed)) continue;
    if (ISSUE_PROMPT_NOISE_RE.test(trimmed)) continue;
    if (SOURCE_PATH_LINE_RE.test(trimmed) && STATIC_CODE_ALERT_RE.test(trimmed)) continue;
    if (SOURCE_PATH_LINE_RE.test(trimmed)) {
      const sourceContent = trimmed.replace(SOURCE_PATH_LINE_RE, "").trim();
      if (looksLikeStructuredAlertLiteral(sourceContent) || looksLikeAlertRegexLiteral(sourceContent)) continue;
    }
    if (looksLikeAlertRegexLiteral(trimmed)) continue;
    if (looksLikeStructuredAlertLiteral(trimmed)) continue;

    // Alphanumeric density check: drop lines mostly composed of special characters
    const alnumCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
    if (trimmed.length >= 8 && alnumCount / trimmed.length < MIN_ALNUM_RATIO) continue;

    meaningful.push(stripped.trimEnd());
  }

  const trimmed = trimReviewSeedPrefix(meaningful);
  return trimmed.slice(-maxLines).join("\n");
}

/**
 * Append tmux tail content to a message if present in the payload.
 */
function appendTmuxTail(lines: string[], payload: NotificationPayload): void {
  if (payload.tmuxTail) {
    // payload.tmuxTail is already parsed by notify() — use directly to
    // avoid re-filtering that silently drops lines on the second pass
    const tail = payload.tmuxTail.trim();
    if (tail) {
      lines.push("");
      lines.push("**Recent output:**");
      lines.push("```");
      lines.push(tail);
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
