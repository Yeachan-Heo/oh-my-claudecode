/**
 * OpenClaw Gateway Dispatcher
 *
 * Sends instruction payloads to OpenClaw gateways via HTTP or CLI command.
 * All calls are non-blocking with timeouts. Failures are swallowed
 * to avoid blocking hooks.
 */
/** Default per-request timeout */
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Validate gateway URL. Must be HTTPS, except localhost/127.0.0.1
 * which allows HTTP for local development.
 */
function validateGatewayUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:")
            return true;
        if (parsed.protocol === "http:" &&
            (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1")) {
            return true;
        }
        return false;
    }
    catch {
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
 * - {{signalKind}} / {{signalName}} / {{signalPhase}} / {{signalRouteKey}}
 * - {{signalPriority}} / {{signalSummary}}
 * - {{testRunner}} / {{prUrl}} / {{command}}
 * - {{payloadJson}} - full normalized payload JSON for native command gateways
 *
 * Unresolved variables are left as-is (not replaced with empty string).
 */
export function interpolateInstruction(template, variables) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return variables[key] ?? match;
    });
}
/**
 * Type guard: is this gateway config a command gateway?
 */
export function isCommandGateway(config) {
    return config.type === "command";
}
/**
 * Shell-escape a string for safe embedding in a shell command.
 * Uses single-quote wrapping with internal quote escaping.
 * Follows the sanitizeForTmux pattern from tmux-detector.ts.
 */
export function shellEscapeArg(value) {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
/**
 * Wake an HTTP-type OpenClaw gateway with the given payload.
 */
export async function wakeGateway(gatewayName, gatewayConfig, payload) {
    if (!validateGatewayUrl(gatewayConfig.url)) {
        return {
            gateway: gatewayName,
            success: false,
            error: "Invalid URL (HTTPS required)",
        };
    }
    try {
        const headers = {
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
    }
    catch (error) {
        return {
            gateway: gatewayName,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
/**
 * Wake a command-type OpenClaw gateway by executing a shell command.
 *
 * The command template supports {{variable}} placeholders. All variable
 * values are shell-escaped before interpolation to prevent injection.
 */
export async function wakeCommandGateway(gatewayName, gatewayConfig, variables, payload) {
    try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        // Interpolate variables with shell escaping
        const command = gatewayConfig.command.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            const value = variables[key];
            if (value === undefined)
                return match;
            return shellEscapeArg(value);
        });
        const timeout = gatewayConfig.timeout ?? DEFAULT_TIMEOUT_MS;
        const payloadJson = payload ? JSON.stringify(payload) : variables.payloadJson;
        await execFileAsync("sh", ["-c", command], {
            timeout,
            env: {
                ...process.env,
                ...(payloadJson ? { OPENCLAW_PAYLOAD_JSON: payloadJson } : {}),
                ...(variables.signalRouteKey ? { OPENCLAW_SIGNAL_ROUTE_KEY: variables.signalRouteKey } : {}),
                ...(variables.signalPhase ? { OPENCLAW_SIGNAL_PHASE: variables.signalPhase } : {}),
                ...(variables.signalKind ? { OPENCLAW_SIGNAL_KIND: variables.signalKind } : {}),
            },
        });
        return { gateway: gatewayName, success: true };
    }
    catch (error) {
        return {
            gateway: gatewayName,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
//# sourceMappingURL=dispatcher.js.map