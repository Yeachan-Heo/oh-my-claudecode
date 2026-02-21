/**
 * Notification System - Public API
 *
 * Multi-platform lifecycle notifications for oh-my-claudecode.
 * Sends notifications to Discord, Telegram, Slack, and generic webhooks
 * on session lifecycle events.
 *
 * Usage:
 *   import { notify } from '../notifications/index.js';
 *   await notify('session-start', { sessionId, projectPath, ... });
 */
export { dispatchNotifications, sendDiscord, sendDiscordBot, sendTelegram, sendSlack, sendWebhook, } from "./dispatcher.js";
export { formatNotification, formatSessionStart, formatSessionStop, formatSessionEnd, formatSessionIdle, formatAskUserQuestion, formatAgentCall, } from "./formatter.js";
export { getCurrentTmuxSession, getCurrentTmuxPaneId, getTeamTmuxSessions, formatTmuxInfo, } from "./tmux.js";
export { getNotificationConfig, isEventEnabled, getEnabledPlatforms, getVerbosity, isEventAllowedByVerbosity, shouldIncludeTmuxTail, } from "./config.js";
import { getNotificationConfig, isEventEnabled, getVerbosity, isEventAllowedByVerbosity, shouldIncludeTmuxTail, } from "./config.js";
import { formatNotification } from "./formatter.js";
import { dispatchNotifications } from "./dispatcher.js";
import { getCurrentTmuxSession } from "./tmux.js";
import { basename } from "path";
/**
 * High-level notification function.
 *
 * Reads config, checks if the event is enabled, formats the message,
 * and dispatches to all configured platforms. Non-blocking, swallows errors.
 *
 * @param event - The notification event type
 * @param data - Partial payload data (message will be auto-formatted if not provided)
 * @returns DispatchResult or null if notifications are not configured/enabled
 */
export async function notify(event, data) {
    // OMC_NOTIFY=0 suppresses all CCNotifier events (set by `omc --notify false`)
    if (process.env.OMC_NOTIFY === '0') {
        return null;
    }
    try {
        const config = getNotificationConfig(data.profileName);
        if (!config || !isEventEnabled(config, event)) {
            return null;
        }
        // Verbosity filter (second gate after isEventEnabled)
        const verbosity = getVerbosity(config);
        if (!isEventAllowedByVerbosity(verbosity, event)) {
            return null;
        }
        // Get tmux pane ID
        const { getCurrentTmuxPaneId } = await import("./tmux.js");
        // Build the full payload
        const payload = {
            event,
            sessionId: data.sessionId,
            message: "", // Will be formatted below
            timestamp: data.timestamp || new Date().toISOString(),
            tmuxSession: data.tmuxSession ?? getCurrentTmuxSession() ?? undefined,
            tmuxPaneId: data.tmuxPaneId ?? getCurrentTmuxPaneId() ?? undefined,
            projectPath: data.projectPath,
            projectName: data.projectName ||
                (data.projectPath ? basename(data.projectPath) : undefined),
            modesUsed: data.modesUsed,
            contextSummary: data.contextSummary,
            durationMs: data.durationMs,
            agentsSpawned: data.agentsSpawned,
            agentsCompleted: data.agentsCompleted,
            reason: data.reason,
            activeMode: data.activeMode,
            iteration: data.iteration,
            maxIterations: data.maxIterations,
            question: data.question,
            incompleteTasks: data.incompleteTasks,
            agentName: data.agentName,
            agentType: data.agentType,
        };
        // Capture tmux tail for events that benefit from it
        if (shouldIncludeTmuxTail(verbosity) &&
            payload.tmuxPaneId &&
            (event === "session-idle" || event === "session-end" || event === "session-stop")) {
            try {
                const { capturePaneContent } = await import("../features/rate-limit-wait/tmux-detector.js");
                const tail = capturePaneContent(payload.tmuxPaneId, 15);
                if (tail) {
                    payload.tmuxTail = tail;
                }
            }
            catch {
                // Non-blocking: tmux capture is best-effort
            }
        }
        // Format the message
        payload.message = data.message || formatNotification(payload);
        // Dispatch to all enabled platforms
        const result = await dispatchNotifications(config, event, payload);
        // NEW: Register message IDs for reply correlation
        if (result.anySuccess && payload.tmuxPaneId) {
            try {
                const { registerMessage } = await import("./session-registry.js");
                for (const r of result.results) {
                    if (r.success &&
                        r.messageId &&
                        (r.platform === "discord-bot" || r.platform === "telegram")) {
                        registerMessage({
                            platform: r.platform,
                            messageId: r.messageId,
                            sessionId: payload.sessionId,
                            tmuxPaneId: payload.tmuxPaneId,
                            tmuxSessionName: payload.tmuxSession || "",
                            event: payload.event,
                            createdAt: new Date().toISOString(),
                            projectPath: payload.projectPath,
                        });
                    }
                }
            }
            catch {
                // Non-fatal: reply correlation is best-effort
            }
        }
        return result;
    }
    catch (error) {
        // Never let notification failures propagate to hooks
        console.error("[notifications] Error:", error instanceof Error ? error.message : error);
        return null;
    }
}
//# sourceMappingURL=index.js.map