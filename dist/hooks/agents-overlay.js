/**
 * Agents Overlay
 *
 * Integration layer that injects startup context (codebase map, project hints)
 * into the Claude Code session before the first agent message.
 *
 * Called from processSessionStart in bridge.ts.
 * Issue #804 - Startup codebase map injection hook
 */
import { generateCodebaseMap } from './codebase-map.js';
import { loadConfig } from '../config/loader.js';
/**
 * Build the startup overlay context for a session.
 *
 * Generates a compressed codebase map and formats it as a session-restore
 * block. Returns an empty result when disabled or when the directory is absent.
 */
export function buildAgentsOverlay(directory, options) {
    const config = loadConfig();
    const mapConfig = config.startupCodebaseMap ?? {};
    // Respect the enabled flag (default: true)
    if (mapConfig.enabled === false) {
        return { message: '', hasCodebaseMap: false };
    }
    const mergedOptions = {
        maxFiles: mapConfig.maxFiles ?? options?.maxFiles ?? 200,
        maxDepth: mapConfig.maxDepth ?? options?.maxDepth ?? 4,
        ignorePatterns: options?.ignorePatterns ?? [],
        includeMetadata: options?.includeMetadata ?? true,
    };
    const result = generateCodebaseMap(directory, mergedOptions);
    if (!result.map) {
        return { message: '', hasCodebaseMap: false };
    }
    const message = `<session-restore>

[CODEBASE MAP]

Project structure for: ${directory}
Use this map to navigate efficiently. Prefer Glob/Grep over blind file exploration.

${result.map}

</session-restore>

---

`;
    return { message, hasCodebaseMap: true };
}
//# sourceMappingURL=agents-overlay.js.map