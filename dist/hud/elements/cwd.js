/**
 * OMC HUD - CWD Element
 *
 * Renders current working directory with configurable format.
 * Supports OSC 8 terminal hyperlinks for supported terminals (iTerm2, WezTerm, etc.)
 */
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { dim } from '../colors.js';
/**
 * Wrap text in an OSC 8 terminal hyperlink.
 * Supported by: iTerm2, WezTerm, Kitty, Hyper, Windows Terminal, VTE-based terminals.
 * Format: ESC]8;;URL ESC\ TEXT ESC]8;; ESC\
 */
function osc8Link(url, text) {
    return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
/**
 * Convert an absolute filesystem path to a file:// URL.
 * Handles Windows paths (C:\path -> file:///C:/path).
 */
function pathToFileUrl(absPath) {
    // Normalize backslashes on Windows
    const normalized = absPath.replace(/\\/g, '/');
    // Windows absolute path (e.g. C:/...)
    if (/^[A-Za-z]:\//.test(normalized)) {
        return `file:///${normalized}`;
    }
    return `file://${normalized}`;
}
/**
 * Render current working directory based on format.
 *
 * @param cwd - Absolute path to current working directory
 * @param format - Display format (relative, absolute, folder)
 * @param useHyperlinks - Wrap in OSC 8 hyperlink (file:// URL)
 * @returns Formatted path string or null if empty
 */
export function renderCwd(cwd, format = 'relative', useHyperlinks = false) {
    if (!cwd)
        return null;
    let displayPath;
    switch (format) {
        case 'relative': {
            const home = homedir();
            displayPath = cwd.startsWith(home)
                ? '~' + cwd.slice(home.length)
                : cwd;
            break;
        }
        case 'absolute':
            displayPath = cwd;
            break;
        case 'folder': {
            // Show "parent/leaf" instead of just "leaf" to disambiguate common
            // directory names like src/, test/, docs/, packages/core, apps/web.
            const parent = basename(dirname(cwd));
            const folder = basename(cwd);
            displayPath = parent ? join(parent, folder) : folder;
            break;
        }
        default:
            displayPath = cwd;
    }
    const rendered = `${dim(displayPath)}`;
    if (useHyperlinks) {
        const url = pathToFileUrl(cwd);
        return osc8Link(url, rendered);
    }
    return rendered;
}
//# sourceMappingURL=cwd.js.map