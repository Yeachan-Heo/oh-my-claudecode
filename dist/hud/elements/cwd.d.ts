/**
 * OMC HUD - CWD Element
 *
 * Renders current working directory with configurable format.
 */
import type { CwdFormat } from '../types.js';
/**
 * Render current working directory based on format.
 *
 * @param cwd - Absolute path to current working directory
 * @param format - Display format (relative, absolute, folder)
 * @returns Formatted path string or null if empty
 */
export declare function renderCwd(cwd: string | undefined, format?: CwdFormat): string | null;
//# sourceMappingURL=cwd.d.ts.map