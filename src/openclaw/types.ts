/**
 * OpenClaw Gateway Integration Types
 *
 * Defines types for the OpenClaw gateway waker system.
 * Each hook event can be mapped to a gateway with a pre-defined instruction.
 */

/** Hook events that can trigger OpenClaw gateway calls */
export type OpenClawHookEvent =
  | "session-start"
  | "session-end"
  | "pre-tool-use"
  | "post-tool-use"
  | "stop"
  | "keyword-detector"
  | "ask-user-question";

/** Single gateway endpoint configuration */
export interface OpenClawGatewayConfig {
  /** Gateway endpoint URL (HTTPS required) */
  url: string;
  /** Optional custom headers (e.g., Authorization) */
  headers?: Record<string, string>;
  /** HTTP method (default: POST) */
  method?: "POST" | "PUT";
  /** Per-request timeout in ms (default: 10000) */
  timeout?: number;
}

/** Per-hook-event mapping to a gateway + instruction */
export interface OpenClawHookMapping {
  /** Name of the gateway (key in gateways object) */
  gateway: string;
  /** Instruction template with {{variable}} placeholders */
  instruction: string;
  /** Whether this hook-event mapping is active */
  enabled: boolean;
}

/** Top-level config schema for omc_config.openclaw.json */
export interface OpenClawConfig {
  /** Global enable/disable */
  enabled: boolean;
  /** Named gateway endpoints */
  gateways: Record<string, OpenClawGatewayConfig>;
  /** Hook-event to gateway+instruction mappings */
  hooks: Partial<Record<OpenClawHookEvent, OpenClawHookMapping>>;
}

/** Payload sent to an OpenClaw gateway */
export interface OpenClawPayload {
  /** The hook event that triggered this call */
  event: OpenClawHookEvent;
  /** Interpolated instruction text */
  instruction: string;
  /** ISO timestamp */
  timestamp: string;
  /** Session identifier (if available) */
  sessionId?: string;
  /** Project directory path */
  projectPath?: string;
  /** Project basename */
  projectName?: string;
  /** Tmux session name (if running inside tmux) */
  tmuxSession?: string;
  /** Context data from the hook (whitelisted fields only) */
  context: OpenClawContext;
}

/**
 * Context data passed from the hook to OpenClaw for template interpolation.
 *
 * All fields are explicitly enumerated (no index signature) to prevent
 * accidental leakage of sensitive data into gateway payloads.
 */
export interface OpenClawContext {
  sessionId?: string;
  projectPath?: string;
  tmuxSession?: string;
  toolName?: string;
  prompt?: string;
  contextSummary?: string;
  reason?: string;
  question?: string;
}

/** Result of a gateway wake attempt */
export interface OpenClawResult {
  /** Gateway name */
  gateway: string;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** HTTP status code if available */
  statusCode?: number;
}
