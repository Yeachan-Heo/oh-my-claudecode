/**
 * OpenClaw MCP Core - Integration with OpenClaw AI agent runtime
 *
 * OpenClaw is a personal AI assistant runtime with multi-agent orchestration,
 * cron scheduling, browser control, and messaging integrations.
 *
 * This module enables OMC to leverage OpenClaw's 24/7 agent capabilities:
 * - Spawn sub-agents via sessions_spawn
 * - Persistent memory across sessions
 * - Messaging integrations (WhatsApp, Telegram, Discord)
 * - Browser automation
 *
 * @see https://github.com/openclaw/openclaw
 * @see https://docs.openclaw.ai
 */
export declare const OPENCLAW_DEFAULT_MODEL: string;
export declare const OPENCLAW_TIMEOUT: number;
/**
 * Detect if OpenClaw CLI is installed and available
 */
export declare function detectOpenclawCli(): string | null;
/**
 * Check if OpenClaw gateway is running
 */
export declare function isGatewayRunning(): Promise<boolean>;
/**
 * Spawn a sub-agent task via OpenClaw
 *
 * This uses OpenClaw's sessions_spawn to run a task in an isolated session,
 * returning results when complete.
 */
export declare function spawnOpenclawAgent(options: {
    task: string;
    model?: string;
    label?: string;
    timeoutSeconds?: number;
    agentId?: string;
}): Promise<{
    success: boolean;
    result?: string;
    error?: string;
    sessionKey?: string;
}>;
/**
 * Send a message to an existing OpenClaw session
 */
export declare function sendToSession(sessionKey: string, message: string): Promise<{
    success: boolean;
    result?: string;
    error?: string;
}>;
/**
 * Get OpenClaw system info for diagnostics
 */
export declare function getOpenclawInfo(): {
    installed: boolean;
    cliPath: string | null;
    version: string | null;
};
//# sourceMappingURL=openclaw-core.d.ts.map