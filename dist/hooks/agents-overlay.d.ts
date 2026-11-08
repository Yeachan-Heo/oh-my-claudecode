/**
 * Agents Overlay
 *
 * Integration layer that injects startup context (codebase map, project hints)
 * into the Claude Code session before the first agent message.
 *
 * Called from processSessionStart in bridge.ts.
 * Issue #804 - Startup codebase map injection hook
 */
import { type CodebaseMapOptions } from './codebase-map.js';
export interface AgentsOverlayResult {
    /** Context message to prepend, or empty string if nothing to inject */
    message: string;
    /** Whether the codebase map was included */
    hasCodebaseMap: boolean;
}
/**
 * Build the startup overlay context for a session.
 *
 * Generates a compressed codebase map and formats it as a session-restore
 * block. Returns an empty result when disabled or when the directory is absent.
 */
export declare function buildAgentsOverlay(directory: string, options?: CodebaseMapOptions): AgentsOverlayResult;
//# sourceMappingURL=agents-overlay.d.ts.map