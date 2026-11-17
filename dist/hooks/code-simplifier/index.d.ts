/**
 * Code Simplifier Stop Hook
 *
 * Intercepts Stop events to automatically delegate recently modified files
 * to the code-simplifier agent for cleanup and simplification.
 *
 * Opt-in via global OMC config.json (XDG-aware on Linux/Unix, legacy ~/.omc fallback)
 * Default: disabled (opt-in only)
 */
/** Config shape for the code-simplifier feature */
export interface CodeSimplifierConfig {
    enabled: boolean;
    /** File extensions to include (default: common source extensions) */
    extensions?: string[];
    /** Maximum number of files to simplify per stop event (default: 10) */
    maxFiles?: number;
}
/** Global OMC config shape (subset relevant to code-simplifier) */
interface OmcGlobalConfig {
    codeSimplifier?: CodeSimplifierConfig;
}
/** Result returned to the Stop hook dispatcher */
export interface CodeSimplifierHookResult {
    shouldBlock: boolean;
    message: string;
}
/** Marker filename used to prevent re-triggering within the same turn cycle */
export declare const TRIGGER_MARKER_FILENAME = "code-simplifier-triggered.marker";
/**
 * Read the global OMC config from the XDG-aware location, with legacy
 * ~/.omc/config.json fallback for backward compatibility.
 * Returns null if the file does not exist or cannot be parsed.
 */
export declare function readOmcConfig(): OmcGlobalConfig | null;
/**
 * Check whether the code-simplifier feature is enabled in config.
 * Disabled by default — requires explicit opt-in.
 */
export declare function isCodeSimplifierEnabled(): boolean;
/**
 * Get list of recently modified source files via `git diff HEAD --name-only`.
 * Returns an empty array if git is unavailable or no files are modified.
 */
export declare function getModifiedFiles(cwd: string, extensions?: string[], maxFiles?: number): string[];
/**
 * Check whether the code-simplifier was already triggered this turn
 * (marker file present in the state directory).
 */
export declare function isAlreadyTriggered(stateDir: string): boolean;
/**
 * Write the trigger marker to prevent re-triggering in the same turn cycle.
 */
export declare function writeTriggerMarker(stateDir: string): void;
/**
 * Clear the trigger marker after a completed simplification round,
 * allowing the hook to trigger again on the next turn.
 */
export declare function clearTriggerMarker(stateDir: string): void;
/**
 * Build the message injected into Claude's context when code-simplifier triggers.
 */
export declare function buildSimplifierMessage(files: string[]): string;
/**
 * Process the code-simplifier stop hook.
 *
 * Logic:
 * 1. Return early (no block) if the feature is disabled
 * 2. If already triggered this turn (marker present), clear marker and allow stop
 * 3. Get modified files via git diff HEAD
 * 4. Return early if no relevant files are modified
 * 5. Write trigger marker and inject the simplifier delegation message
 */
export declare function processCodeSimplifier(cwd: string, stateDir: string): CodeSimplifierHookResult;
export {};
//# sourceMappingURL=index.d.ts.map