/**
 * OpenClaw Integration - Public API
 *
 * Wakes OpenClaw gateways on hook events. Non-blocking, fire-and-forget.
 *
 * Usage (from bridge.ts via _openclaw wrapper):
 *   _openclaw.wake("session-start", { sessionId, projectPath: directory });
 */

export type {
  OpenClawConfig,
  OpenClawContext,
  OpenClawGatewayConfig,
  OpenClawHookEvent,
  OpenClawHookMapping,
  OpenClawPayload,
  OpenClawResult,
} from "./types.js";

export { getOpenClawConfig, resolveGateway, resetOpenClawConfigCache } from "./config.js";
export { wakeGateway, interpolateInstruction } from "./dispatcher.js";

import type { OpenClawHookEvent, OpenClawContext, OpenClawResult } from "./types.js";
import { getOpenClawConfig, resolveGateway } from "./config.js";
import { wakeGateway, interpolateInstruction } from "./dispatcher.js";
import { basename } from "path";
import { getCurrentTmuxSession } from "../notifications/tmux.js";

/** Whether debug logging is enabled */
const DEBUG = process.env.OMC_OPENCLAW_DEBUG === "1";

/**
 * Build a whitelisted context object from the input context.
 * Only known fields are included to prevent accidental data leakage.
 */
function buildWhitelistedContext(context: OpenClawContext): OpenClawContext {
  const result: OpenClawContext = {};
  if (context.sessionId !== undefined) result.sessionId = context.sessionId;
  if (context.projectPath !== undefined) result.projectPath = context.projectPath;
  if (context.tmuxSession !== undefined) result.tmuxSession = context.tmuxSession;
  if (context.toolName !== undefined) result.toolName = context.toolName;
  if (context.prompt !== undefined) result.prompt = context.prompt;
  if (context.contextSummary !== undefined) result.contextSummary = context.contextSummary;
  if (context.reason !== undefined) result.reason = context.reason;
  if (context.question !== undefined) result.question = context.question;
  return result;
}

/**
 * Wake the OpenClaw gateway mapped to a hook event.
 *
 * This is the main entry point called from the hook bridge via _openclaw.wake().
 * Non-blocking, swallows all errors. Returns null if OpenClaw
 * is not configured or the event is not mapped.
 *
 * @param event - The hook event type
 * @param context - Context data for template variable interpolation
 * @returns OpenClawResult or null if not configured/mapped
 */
export async function wakeOpenClaw(
  event: OpenClawHookEvent,
  context: OpenClawContext,
): Promise<OpenClawResult | null> {
  try {
    const config = getOpenClawConfig();
    if (!config) return null;

    const resolved = resolveGateway(config, event);
    if (!resolved) return null;

    const { gatewayName, gateway, instruction } = resolved;

    // Single timestamp for both template variables and payload
    const now = new Date().toISOString();

    // Auto-detect tmux session if not provided in context
    const tmuxSession = context.tmuxSession ?? getCurrentTmuxSession() ?? undefined;

    // Build template variables from whitelisted context fields
    const variables: Record<string, string | undefined> = {
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      projectName: context.projectPath ? basename(context.projectPath) : undefined,
      tmuxSession,
      toolName: context.toolName,
      prompt: context.prompt,
      contextSummary: context.contextSummary,
      reason: context.reason,
      question: context.question,
      event,
      timestamp: now,
    };

    const interpolatedInstruction = interpolateInstruction(instruction, variables);

    const payload = {
      event,
      instruction: interpolatedInstruction,
      timestamp: now,
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      projectName: context.projectPath ? basename(context.projectPath) : undefined,
      tmuxSession,
      context: buildWhitelistedContext(context),
    };

    const result = await wakeGateway(gatewayName, gateway, payload);

    if (DEBUG) {
      console.error(`[openclaw] wake ${event} -> ${gatewayName}: ${result.success ? "ok" : result.error}`);
    }

    return result;
  } catch (error) {
    // Never let OpenClaw failures propagate to hooks
    if (DEBUG) {
      console.error(`[openclaw] wakeOpenClaw error:`, error instanceof Error ? error.message : error);
    }
    return null;
  }
}
