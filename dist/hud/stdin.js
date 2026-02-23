/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
/**
 * Read and parse stdin JSON from Claude Code.
 * Returns null if stdin is not available or invalid.
 */
export async function readStdin() {
    // Skip if running in TTY mode (interactive terminal)
    if (process.stdin.isTTY) {
        return null;
    }
    const chunks = [];
    try {
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const raw = chunks.join('');
        if (!raw.trim()) {
            return null;
        }
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Get total tokens from stdin context_window.current_usage
 */
function getTotalTokens(stdin) {
    const usage = stdin.context_window?.current_usage;
    return ((usage?.input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0));
}
/**
 * Get context window usage percentage.
 * Prefers native percentage from Claude Code v2.1.6+, falls back to manual calculation.
 */
export function getContextPercent(stdin) {
    // Prefer native percentage (v2.1.6+) - accurate and matches /context
    const nativePercent = stdin.context_window?.used_percentage;
    if (typeof nativePercent === 'number' && !Number.isNaN(nativePercent)) {
        return Math.min(100, Math.max(0, Math.round(nativePercent)));
    }
    // Fallback: manual calculation
    const size = stdin.context_window?.context_window_size;
    if (!size || size <= 0) {
        return 0;
    }
    const totalTokens = getTotalTokens(stdin);
    return Math.min(100, Math.round((totalTokens / size) * 100));
}
/**
 * Get model display name from stdin.
 */
export function getModelName(stdin) {
    return stdin.model?.id ?? stdin.model?.display_name ?? 'Unknown';
}
/**
 * Cache stdin data to disk so the --watch mode (tmux pane) can read it.
 * Called by the normal Claude Code statusline path after receiving stdin.
 */
export function writeStdinCache(data, cwd) {
    try {
        const stateDir = join(cwd, '.omc', 'state');
        if (!existsSync(stateDir)) {
            mkdirSync(stateDir, { recursive: true });
        }
        writeFileSync(join(stateDir, 'hud-stdin-cache.json'), JSON.stringify(data));
    }
    catch {
        // Silent failure - don't break HUD rendering
    }
}
/**
 * Read cached stdin data from disk.
 * Used by --watch mode (tmux pane) where stdin is a TTY and not piped from Claude Code.
 */
export function readStdinCache(cwd) {
    try {
        const cachePath = join(cwd, '.omc', 'state', 'hud-stdin-cache.json');
        if (!existsSync(cachePath)) {
            return null;
        }
        const raw = readFileSync(cachePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=stdin.js.map