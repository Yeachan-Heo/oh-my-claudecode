/**
 * OpenClaw Integration - Public API
 *
 * Wakes OpenClaw gateways on hook events. Non-blocking, fire-and-forget.
 *
 * Usage (from bridge.ts via _openclaw wrapper):
 *   _openclaw.wake("session-start", { sessionId, projectPath: directory });
 */
export { getOpenClawConfig, resolveGateway, resetOpenClawConfigCache } from "./config.js";
export { wakeGateway, wakeCommandGateway, interpolateInstruction, isCommandGateway, shellEscapeArg } from "./dispatcher.js";
import { getOpenClawConfig, resolveGateway } from "./config.js";
import { wakeGateway, wakeCommandGateway, interpolateInstruction, isCommandGateway } from "./dispatcher.js";
import { basename } from "path";
import { getCurrentTmuxSession } from "../notifications/tmux.js";
/** Whether debug logging is enabled */
const DEBUG = process.env.OMC_OPENCLAW_DEBUG === "1";
/**
 * Build a whitelisted context object from the input context.
 * Only known fields are included to prevent accidental data leakage.
 */
function buildWhitelistedContext(context) {
    const result = {};
    if (context.sessionId !== undefined)
        result.sessionId = context.sessionId;
    if (context.projectPath !== undefined)
        result.projectPath = context.projectPath;
    if (context.tmuxSession !== undefined)
        result.tmuxSession = context.tmuxSession;
    if (context.toolName !== undefined)
        result.toolName = context.toolName;
    if (context.prompt !== undefined)
        result.prompt = context.prompt;
    if (context.contextSummary !== undefined)
        result.contextSummary = context.contextSummary;
    if (context.reason !== undefined)
        result.reason = context.reason;
    if (context.question !== undefined)
        result.question = context.question;
    if (context.tmuxTail !== undefined)
        result.tmuxTail = context.tmuxTail;
    if (context.replyChannel !== undefined)
        result.replyChannel = context.replyChannel;
    if (context.replyTarget !== undefined)
        result.replyTarget = context.replyTarget;
    if (context.replyThread !== undefined)
        result.replyThread = context.replyThread;
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
export async function wakeOpenClaw(event, context) {
    try {
        const config = getOpenClawConfig();
        if (!config)
            return null;
        const resolved = resolveGateway(config, event);
        if (!resolved)
            return null;
        const { gatewayName, gateway, instruction } = resolved;
        // Single timestamp for both template variables and payload
        const now = new Date().toISOString();
        // Auto-detect tmux session if not provided in context
        const tmuxSession = context.tmuxSession ?? getCurrentTmuxSession() ?? undefined;
        // Auto-capture tmux pane content for stop/session-end events (best-effort)
        let tmuxTail = context.tmuxTail;
        if (!tmuxTail && (event === "stop" || event === "session-end") && process.env.TMUX) {
            try {
                const { capturePaneContent } = await import("../features/rate-limit-wait/tmux-detector.js");
                const paneId = process.env.TMUX_PANE;
                if (paneId) {
                    tmuxTail = capturePaneContent(paneId, 15) ?? undefined;
                }
            }
            catch {
                // Non-blocking: tmux capture is best-effort
            }
        }
        // Read reply channel context from environment variables
        const replyChannel = context.replyChannel ?? process.env.OPENCLAW_REPLY_CHANNEL ?? undefined;
        const replyTarget = context.replyTarget ?? process.env.OPENCLAW_REPLY_TARGET ?? undefined;
        const replyThread = context.replyThread ?? process.env.OPENCLAW_REPLY_THREAD ?? undefined;
        // Enrich context with reply channel from env vars
        const enrichedContext = {
            ...context,
            ...(replyChannel && { replyChannel }),
            ...(replyTarget && { replyTarget }),
            ...(replyThread && { replyThread }),
        };
        // Build template variables from whitelisted context fields
        const variables = {
            sessionId: context.sessionId,
            projectPath: context.projectPath,
            projectName: context.projectPath ? basename(context.projectPath) : undefined,
            tmuxSession,
            toolName: context.toolName,
            prompt: context.prompt,
            contextSummary: context.contextSummary,
            reason: context.reason,
            question: context.question,
            tmuxTail,
            event,
            timestamp: now,
            replyChannel,
            replyTarget,
            replyThread,
        };
        // Add interpolated instruction to variables for command gateway {{instruction}} placeholder
        const interpolatedInstruction = interpolateInstruction(instruction, variables);
        variables.instruction = interpolatedInstruction;
        let result;
        if (isCommandGateway(gateway)) {
            // Command gateway: execute shell command with shell-escaped variables
            result = await wakeCommandGateway(gatewayName, gateway, variables);
        }
        else {
            // HTTP gateway: send JSON payload
            const payload = {
                event,
                instruction: interpolatedInstruction,
                timestamp: now,
                sessionId: context.sessionId,
                projectPath: context.projectPath,
                projectName: context.projectPath ? basename(context.projectPath) : undefined,
                tmuxSession,
                tmuxTail,
                ...(replyChannel && { channel: replyChannel }),
                ...(replyTarget && { to: replyTarget }),
                ...(replyThread && { threadId: replyThread }),
                context: buildWhitelistedContext(enrichedContext),
            };
            result = await wakeGateway(gatewayName, gateway, payload);
        }
        if (DEBUG) {
            console.error(`[openclaw] wake ${event} -> ${gatewayName}: ${result.success ? "ok" : result.error}`);
        }
        return result;
    }
    catch (error) {
        // Never let OpenClaw failures propagate to hooks
        if (DEBUG) {
            console.error(`[openclaw] wakeOpenClaw error:`, error instanceof Error ? error.message : error);
        }
        return null;
    }
}
//# sourceMappingURL=index.js.map