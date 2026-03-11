/**
 * OpenClaw Integration - Public API
 *
 * Wakes OpenClaw gateways on hook events. Non-blocking, fire-and-forget.
 *
 * Usage (from bridge.ts via _openclaw wrapper):
 *   _openclaw.wake("session-start", { sessionId, projectPath: directory });
 */
export type { OpenClawCommandGatewayConfig, OpenClawConfig, OpenClawContext, OpenClawGatewayConfig, OpenClawHookEvent, OpenClawHookMapping, OpenClawHttpGatewayConfig, OpenClawPayload, OpenClawResult, OpenClawSignal, OpenClawSignalKind, OpenClawSignalPhase, OpenClawSignalPriority, } from "./types.js";
export { getOpenClawConfig, resolveGateway, resetOpenClawConfigCache } from "./config.js";
export { wakeGateway, wakeCommandGateway, interpolateInstruction, isCommandGateway, shellEscapeArg } from "./dispatcher.js";
export { buildOpenClawSignal } from "./signal.js";
import type { OpenClawHookEvent, OpenClawContext, OpenClawResult } from "./types.js";
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
export declare function wakeOpenClaw(event: OpenClawHookEvent, context: OpenClawContext): Promise<OpenClawResult | null>;
//# sourceMappingURL=index.d.ts.map