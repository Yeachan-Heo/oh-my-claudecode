/**
 * Code Simplifier Stop Hook
 *
 * Intercepts Stop events to automatically delegate recently modified files
 * to the code-simplifier agent for cleanup and simplification.
 *
 * Opt-in via global OMC config.json (XDG-aware on Linux/Unix, legacy ~/.omc fallback)
 * Default: disabled (opt-in only)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { getGlobalOmcConfigCandidates } from '../../utils/paths.js';
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
const DEFAULT_MAX_FILES = 10;
/** Marker filename used to prevent re-triggering within the same turn cycle */
export const TRIGGER_MARKER_FILENAME = 'code-simplifier-triggered.marker';
/**
 * Read the global OMC config from the XDG-aware location, with legacy
 * ~/.omc/config.json fallback for backward compatibility.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readOmcConfig() {
    for (const configPath of getGlobalOmcConfigCandidates('config.json')) {
        if (!existsSync(configPath)) {
            continue;
        }
        try {
            return JSON.parse(readFileSync(configPath, 'utf-8'));
        }
        catch {
            return null;
        }
    }
    return null;
}
/**
 * Check whether the code-simplifier feature is enabled in config.
 * Disabled by default — requires explicit opt-in.
 */
export function isCodeSimplifierEnabled() {
    const config = readOmcConfig();
    return config?.codeSimplifier?.enabled === true;
}
/**
 * Get list of recently modified source files via `git diff HEAD --name-only`.
 * Returns an empty array if git is unavailable or no files are modified.
 */
export function getModifiedFiles(cwd, extensions = DEFAULT_EXTENSIONS, maxFiles = DEFAULT_MAX_FILES) {
    try {
        const output = execFileSync('git', ['diff', 'HEAD', '--name-only'], {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
            windowsHide: true,
        });
        return output
            .trim()
            .split('\n')
            .filter((file) => file.trim().length > 0)
            .filter((file) => extensions.some((ext) => file.endsWith(ext)))
            .slice(0, maxFiles);
    }
    catch {
        return [];
    }
}
/**
 * Check whether the code-simplifier was already triggered this turn
 * (marker file present in the state directory).
 */
export function isAlreadyTriggered(stateDir) {
    return existsSync(join(stateDir, TRIGGER_MARKER_FILENAME));
}
/**
 * Write the trigger marker to prevent re-triggering in the same turn cycle.
 */
export function writeTriggerMarker(stateDir) {
    try {
        if (!existsSync(stateDir)) {
            mkdirSync(stateDir, { recursive: true });
        }
        writeFileSync(join(stateDir, TRIGGER_MARKER_FILENAME), new Date().toISOString(), 'utf-8');
    }
    catch {
        // Ignore write errors — marker is best-effort
    }
}
/**
 * Clear the trigger marker after a completed simplification round,
 * allowing the hook to trigger again on the next turn.
 */
export function clearTriggerMarker(stateDir) {
    try {
        const markerPath = join(stateDir, TRIGGER_MARKER_FILENAME);
        if (existsSync(markerPath)) {
            unlinkSync(markerPath);
        }
    }
    catch {
        // Ignore removal errors
    }
}
/**
 * Build the message injected into Claude's context when code-simplifier triggers.
 */
export function buildSimplifierMessage(files) {
    const fileList = files.map((f) => `  - ${f}`).join('\n');
    const fileArgs = files.join('\\n');
    return `[CODE SIMPLIFIER] Recently modified files detected. Delegate to the code-simplifier agent to simplify the following files for clarity, consistency, and maintainability (without changing behavior):

${fileList}

Use: Task(subagent_type="oh-my-claudecode:code-simplifier", prompt="Simplify the recently modified files:\\n${fileArgs}")`;
}
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
export function processCodeSimplifier(cwd, stateDir) {
    if (!isCodeSimplifierEnabled()) {
        return { shouldBlock: false, message: '' };
    }
    // If already triggered this turn, clear marker and allow stop
    if (isAlreadyTriggered(stateDir)) {
        clearTriggerMarker(stateDir);
        return { shouldBlock: false, message: '' };
    }
    const config = readOmcConfig();
    const extensions = config?.codeSimplifier?.extensions ?? DEFAULT_EXTENSIONS;
    const maxFiles = config?.codeSimplifier?.maxFiles ?? DEFAULT_MAX_FILES;
    const files = getModifiedFiles(cwd, extensions, maxFiles);
    if (files.length === 0) {
        return { shouldBlock: false, message: '' };
    }
    writeTriggerMarker(stateDir);
    return {
        shouldBlock: true,
        message: buildSimplifierMessage(files),
    };
}
//# sourceMappingURL=index.js.map