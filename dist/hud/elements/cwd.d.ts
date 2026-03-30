/**
 * OMC HUD - CWD Element
 *
 * Renders current working directory with configurable format.
 * Supports OSC 8 terminal hyperlinks for supported terminals (iTerm2, WezTerm, etc.)
 */
import type { CwdFormat } from '../types.js';
/**
 * Render current working directory based on format.
 *
 * @param cwd - Absolute path to current working directory
 * @param format - Display format (relative, absolute, folder)
 * @param useHyperlinks - Wrap in OSC 8 hyperlink (file:// URL)
 * @returns Formatted path string or null if empty
 */
export declare function renderCwd(cwd: string | undefined, format?: CwdFormat, useHyperlinks?: boolean): string | null;
//# sourceMappingURL=cwd.d.ts.map