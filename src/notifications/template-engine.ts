/**
 * Template Interpolation Engine
 *
 * Lightweight {{variable}} interpolation with {{#if var}}...{{/if}} conditionals.
 * No external dependencies. Produces output matching current formatter.ts functions.
 */

import type { NotificationPayload, NotificationEvent } from "./types.js";
import { parseTmuxTail } from "./formatter.js";
import { basename } from "path";

/** Set of known template variables for validation */
const KNOWN_VARIABLES = new Set<string>([
  // Raw payload fields
  "event", "sessionId", "message", "timestamp", "tmuxSession",
  "projectPath", "projectName", "modesUsed", "contextSummary",
  "durationMs", "agentsSpawned", "agentsCompleted",
  "reason", "activeMode", "iteration", "maxIterations",
  "question", "incompleteTasks", "agentName", "agentType",
  "tmuxTail", "tmuxPaneId",
  // Computed variables
  "duration", "time", "modesDisplay", "iterationDisplay",
  "agentDisplay", "projectDisplay", "footer", "tmuxTailBlock",
  "reasonDisplay",
]);

/**
 * Format duration from milliseconds to human-readable string.
 * Mirrors formatDuration() in formatter.ts.
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
 * Get project display name from payload.
 * Mirrors projectDisplay() in formatter.ts.
 */
function getProjectDisplay(payload: NotificationPayload): string {
  if (payload.projectName) return payload.projectName;
  if (payload.projectPath) return basename(payload.projectPath);
  return "unknown";
}

/**
 * Build common footer with tmux and project info (markdown).
 * Mirrors buildFooter(payload, true) in formatter.ts.
 */
function buildFooterText(payload: NotificationPayload): string {
  const parts: string[] = [];
  if (payload.tmuxSession) {
    parts.push(`**tmux:** \`${payload.tmuxSession}\``);
  }
  parts.push(`**project:** \`${getProjectDisplay(payload)}\``);
  return parts.join(" | ");
}

/**
 * Build tmux tail block with code fence, or empty string.
 * Mirrors appendTmuxTail() in formatter.ts.
 * Includes two leading newlines (blank line separator) to match formatter output.
 */
function buildTmuxTailBlock(payload: NotificationPayload): string {
  if (!payload.tmuxTail) return "";
  const parsed = parseTmuxTail(payload.tmuxTail);
  if (!parsed) return "";
  return `\n\n**Recent output:**\n\`\`\`\n${parsed}\n\`\`\``;
}

/**
 * Build the full variable map from a notification payload.
 * Includes raw payload fields (string-converted) and computed variables.
 */
export function computeTemplateVariables(
  payload: NotificationPayload,
): Record<string, string> {
  const vars: Record<string, string> = {};

  // Raw payload fields (null/undefined → "")
  vars.event = payload.event || "";
  vars.sessionId = payload.sessionId || "";
  vars.message = payload.message || "";
  vars.timestamp = payload.timestamp || "";
  vars.tmuxSession = payload.tmuxSession || "";
  vars.projectPath = payload.projectPath || "";
  vars.projectName = payload.projectName || "";
  vars.modesUsed = payload.modesUsed?.join(", ") || "";
  vars.contextSummary = payload.contextSummary || "";
  vars.durationMs =
    payload.durationMs != null ? String(payload.durationMs) : "";
  vars.agentsSpawned =
    payload.agentsSpawned != null ? String(payload.agentsSpawned) : "";
  vars.agentsCompleted =
    payload.agentsCompleted != null ? String(payload.agentsCompleted) : "";
  vars.reason = payload.reason || "";
  vars.activeMode = payload.activeMode || "";
  vars.iteration =
    payload.iteration != null ? String(payload.iteration) : "";
  vars.maxIterations =
    payload.maxIterations != null ? String(payload.maxIterations) : "";
  vars.question = payload.question || "";
  // incompleteTasks: undefined/null → "" (so {{#if}} is falsy when unset)
  // 0 → "0" (distinguishable from unset; templates can display "0 incomplete tasks")
  vars.incompleteTasks =
    payload.incompleteTasks != null
      ? String(payload.incompleteTasks)
      : "";
  vars.agentName = payload.agentName || "";
  vars.agentType = payload.agentType || "";
  vars.tmuxTail = payload.tmuxTail || "";
  vars.tmuxPaneId = payload.tmuxPaneId || "";

  // Computed variables
  vars.duration = formatDuration(payload.durationMs);
  vars.time = payload.timestamp
    ? new Date(payload.timestamp).toLocaleTimeString()
    : "";
  vars.modesDisplay =
    payload.modesUsed && payload.modesUsed.length > 0
      ? payload.modesUsed.join(", ")
      : "";
  vars.iterationDisplay =
    payload.iteration != null && payload.maxIterations != null
      ? `${payload.iteration}/${payload.maxIterations}`
      : "";
  vars.agentDisplay =
    payload.agentsSpawned != null
      ? `${payload.agentsCompleted ?? 0}/${payload.agentsSpawned} completed`
      : "";
  vars.projectDisplay = getProjectDisplay(payload);
  vars.footer = buildFooterText(payload);
  vars.tmuxTailBlock = buildTmuxTailBlock(payload);
  vars.reasonDisplay = payload.reason || "unknown";

  return vars;
}

/**
 * Process {{#if var}}...{{/if}} conditionals.
 * Only simple truthy checks (non-empty string). No nesting, no else.
 */
function processConditionals(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, content: string) => {
      const value = vars[varName] || "";
      return value ? content : "";
    },
  );
}

/**
 * Replace {{variable}} placeholders with values.
 * Unknown/missing variables become empty string.
 */
function replaceVariables(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, varName: string) => vars[varName] ?? "",
  );
}

/**
 * Post-process interpolated text:
 * - Trim trailing whitespace
 *
 * Note: No newline collapsing — templates use self-contained conditionals
 * (leading \n inside {{#if}} blocks) to produce exact output.
 */
function postProcess(text: string): string {
  return text.trimEnd();
}

/**
 * Interpolate a template string with payload values.
 *
 * 1. Process {{#if var}}...{{/if}} conditionals
 * 2. Replace {{variable}} placeholders
 * 3. Post-process to normalize blank lines
 */
export function interpolateTemplate(
  template: string,
  payload: NotificationPayload,
): string {
  const vars = computeTemplateVariables(payload);
  let result = processConditionals(template, vars);
  result = replaceVariables(result, vars);
  result = postProcess(result);
  return result;
}

/**
 * Validate a template string for unknown variables.
 * Returns { valid, unknownVars }.
 */
export function validateTemplate(
  template: string,
): { valid: boolean; unknownVars: string[] } {
  const unknownVars: string[] = [];

  // Check {{#if var}} conditionals
  for (const m of template.matchAll(/\{\{#if\s+(\w+)\}\}/g)) {
    if (!KNOWN_VARIABLES.has(m[1]) && !unknownVars.includes(m[1])) {
      unknownVars.push(m[1]);
    }
  }

  // Check {{variable}} placeholders (skip {{#if}}, {{/if}})
  for (const m of template.matchAll(/\{\{(?!#if\s|\/if)(\w+)\}\}/g)) {
    if (!KNOWN_VARIABLES.has(m[1]) && !unknownVars.includes(m[1])) {
      unknownVars.push(m[1]);
    }
  }

  return { valid: unknownVars.length === 0, unknownVars };
}

/**
 * Default templates that produce output identical to formatter.ts functions.
 *
 * These use self-contained conditionals: each {{#if}} block includes its own
 * leading \n so that false conditionals leave zero residual whitespace.
 * No post-processing collapsing is needed.
 */
const DEFAULT_TEMPLATES: Record<NotificationEvent, string> = {
  "session-start":
    "# Session Started\n\n" +
    "**Session:** `{{sessionId}}`\n" +
    "**Project:** `{{projectDisplay}}`\n" +
    "**Time:** {{time}}" +
    "{{#if tmuxSession}}\n**tmux:** `{{tmuxSession}}`{{/if}}",

  "session-stop":
    "# Session Continuing\n" +
    "{{#if activeMode}}\n**Mode:** {{activeMode}}{{/if}}" +
    "{{#if iterationDisplay}}\n**Iteration:** {{iterationDisplay}}{{/if}}" +
    "{{#if incompleteTasks}}\n**Incomplete tasks:** {{incompleteTasks}}{{/if}}" +
    "\n\n{{footer}}",

  "session-end":
    "# Session Ended\n\n" +
    "**Session:** `{{sessionId}}`\n" +
    "**Duration:** {{duration}}\n" +
    "**Reason:** {{reasonDisplay}}" +
    "{{#if agentDisplay}}\n**Agents:** {{agentDisplay}}{{/if}}" +
    "{{#if modesDisplay}}\n**Modes:** {{modesDisplay}}{{/if}}" +
    "{{#if contextSummary}}\n\n**Summary:** {{contextSummary}}{{/if}}" +
    "{{tmuxTailBlock}}" +
    "\n\n{{footer}}",

  "session-idle":
    "# Session Idle\n\n" +
    "Claude has finished and is waiting for input.\n" +
    "{{#if reason}}\n**Reason:** {{reason}}{{/if}}" +
    "{{#if modesDisplay}}\n**Modes:** {{modesDisplay}}{{/if}}" +
    "{{tmuxTailBlock}}" +
    "\n\n{{footer}}",

  "ask-user-question":
    "# Input Needed\n" +
    "{{#if question}}\n**Question:** {{question}}\n{{/if}}" +
    "\nClaude is waiting for your response.\n\n{{footer}}",

  "agent-call":
    "# Agent Spawned\n" +
    "{{#if agentName}}\n**Agent:** `{{agentName}}`{{/if}}" +
    "{{#if agentType}}\n**Type:** `{{agentType}}`{{/if}}" +
    "\n\n{{footer}}",
};

/**
 * Get the default template for an event type.
 * When interpolated, produces output identical to formatter.ts functions.
 */
export function getDefaultTemplate(event: NotificationEvent): string {
  return DEFAULT_TEMPLATES[event] || `Event: {{event}}`;
}
