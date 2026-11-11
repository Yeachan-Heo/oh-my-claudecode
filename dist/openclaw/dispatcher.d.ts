/**
 * OpenClaw Gateway Dispatcher
 *
 * Sends instruction payloads to OpenClaw gateways via HTTP or CLI command.
 * All calls are non-blocking with timeouts. Failures are swallowed
 * to avoid blocking hooks.
 */
import type { OpenClawCommandGatewayConfig, OpenClawGatewayConfig, OpenClawHttpGatewayConfig, OpenClawPayload, OpenClawResult } from "./types.js";
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
export declare function interpolateInstruction(template: string, variables: Record<string, string | undefined>): string;
/**
 * Type guard: is this gateway config a command gateway?
 */
export declare function isCommandGateway(config: OpenClawGatewayConfig): config is OpenClawCommandGatewayConfig;
/**
 * Shell-escape a string for safe embedding in a shell command.
 * Uses single-quote wrapping with internal quote escaping.
 * Follows the sanitizeForTmux pattern from tmux-detector.ts.
 */
export declare function shellEscapeArg(value: string): string;
/**
 * Wake an HTTP-type OpenClaw gateway with the given payload.
 */
export declare function wakeGateway(gatewayName: string, gatewayConfig: OpenClawHttpGatewayConfig, payload: OpenClawPayload): Promise<OpenClawResult>;
/**
 * Wake a command-type OpenClaw gateway by executing a shell command.
 *
 * The command template supports {{variable}} placeholders. All variable
 * values are shell-escaped before interpolation to prevent injection.
 */
export declare function wakeCommandGateway(gatewayName: string, gatewayConfig: OpenClawCommandGatewayConfig, variables: Record<string, string | undefined>, payload?: OpenClawPayload): Promise<OpenClawResult>;
//# sourceMappingURL=dispatcher.d.ts.map