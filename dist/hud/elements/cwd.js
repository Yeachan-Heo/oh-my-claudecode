/**
 * OMC HUD - CWD Element
 *
 * Renders current working directory with configurable format.
 */
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { dim } from '../colors.js';
/**
 * Render current working directory based on format.
 *
 * @param cwd - Absolute path to current working directory
 * @param format - Display format (relative, absolute, folder)
 * @returns Formatted path string or null if empty
 */
export function renderCwd(cwd, format = 'relative') {
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
        case 'folder':
            displayPath = basename(cwd);
            break;
        default:
            displayPath = cwd;
    }
    return `${dim(displayPath)}`;
}
//# sourceMappingURL=cwd.js.map