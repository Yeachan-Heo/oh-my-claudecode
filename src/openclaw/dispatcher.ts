/**
 * OpenClaw Gateway Dispatcher
 *
 * Sends instruction payloads to OpenClaw gateways via HTTP.
 * All calls are non-blocking with timeouts. Failures are swallowed
 * to avoid blocking hooks.
 */

import type {
  OpenClawGatewayConfig,
  OpenClawPayload,
  OpenClawResult,
} from "./types.js";

/** Default per-request timeout */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Validate gateway URL. Must be HTTPS, except localhost/127.0.0.1
 * which allows HTTP for local development.
 */
function validateGatewayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Interpolate template variables in an instruction string.
 *
 * Supported variables (from hook context):
 * - {{projectName}} - basename of project directory
 * - {{projectPath}} - full project directory path
 * - {{sessionId}} - session identifier
 * - {{toolName}} - tool name (pre/post-tool-use events)
 * - {{prompt}} - prompt text (keyword-detector event)
 * - {{contextSummary}} - context summary (session-end event)
 * - {{question}} - question text (ask-user-question event)
 * - {{timestamp}} - ISO timestamp
 * - {{event}} - hook event name
 *
 * Unresolved variables are left as-is (not replaced with empty string).
 */
export function interpolateInstruction(
  template: string,
  variables: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return variables[key] ?? match;
  });
}

/**
 * Wake an OpenClaw gateway with the given payload.
 */
export async function wakeGateway(
  gatewayName: string,
  gatewayConfig: OpenClawGatewayConfig,
  payload: OpenClawPayload,
): Promise<OpenClawResult> {
  if (!validateGatewayUrl(gatewayConfig.url)) {
    return {
      gateway: gatewayName,
      success: false,
      error: "Invalid URL (HTTPS required)",
    };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...gatewayConfig.headers,
    };

    const timeout = gatewayConfig.timeout ?? DEFAULT_TIMEOUT_MS;

    const response = await fetch(gatewayConfig.url, {
      method: gatewayConfig.method || "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      return {
        gateway: gatewayName,
        success: false,
        error: `HTTP ${response.status}`,
        statusCode: response.status,
      };
    }

    return { gateway: gatewayName, success: true, statusCode: response.status };
  } catch (error) {
    return {
      gateway: gatewayName,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
