/**
 * Hook Notification Configuration Types
 *
 * Schema for omc_config.hook.json — user-customizable message templates
 * with per-event, per-platform overrides.
 */

import type { NotificationPlatform } from "./types.js";

/** Template variables available for interpolation in message templates. */
export type TemplateVariable =
  // Raw payload fields
  | "event" | "sessionId" | "message" | "timestamp" | "tmuxSession"
  | "projectPath" | "projectName" | "modesUsed" | "contextSummary"
  | "durationMs" | "agentsSpawned" | "agentsCompleted"
  | "reason" | "activeMode" | "iteration" | "maxIterations"
  | "question" | "incompleteTasks" | "agentName" | "agentType"
  | "tmuxTail" | "tmuxPaneId"
  // Computed variables (derived from payload, not direct fields)
  | "duration"          // human-readable from durationMs (e.g., "5m 23s")
  | "time"              // locale time string from timestamp
  | "modesDisplay"      // modesUsed.join(", ") or empty string
  | "iterationDisplay"  // "3/10" format or empty string
  | "agentDisplay"      // "2/5 completed" or empty string
  | "projectDisplay"    // projectName || basename(projectPath) || "unknown"
  | "footer"            // buildFooter() composite output
  | "tmuxTailBlock"     // formatted tmux tail with code fence or empty string
  | "reasonDisplay";    // reason || "unknown" (for session-end)

/** Per-platform message template override */
export interface PlatformTemplateOverride {
  /** Message template with {{variable}} placeholders */
  template?: string;
  /** Whether to send this event to this platform (inherits from event-level if not set) */
  enabled?: boolean;
}

/** Per-event hook configuration */
export interface HookEventConfig {
  /** Whether this event fires notifications */
  enabled: boolean;
  /** Default message template for this event (all platforms) */
  template?: string;
  /** Per-platform template overrides */
  platforms?: Partial<Record<NotificationPlatform, PlatformTemplateOverride>>;
}

/** Top-level schema for omc_config.hook.json */
export interface HookNotificationConfig {
  /** Schema version for future migration */
  version: 1;
  /** Global enable/disable */
  enabled: boolean;
  /** Default templates per event (used when no platform override exists) */
  events?: {
    "session-start"?: HookEventConfig;
    "session-stop"?: HookEventConfig;
    "session-end"?: HookEventConfig;
    "session-idle"?: HookEventConfig;
    "ask-user-question"?: HookEventConfig;
    "agent-call"?: HookEventConfig;
  };
  /** Global default template (fallback when event has no template) */
  defaultTemplate?: string;
}
