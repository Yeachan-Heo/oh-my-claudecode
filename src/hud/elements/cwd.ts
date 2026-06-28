/**
 * OMC HUD - CWD Element
 *
 * Renders current working directory with configurable format.
 * Supports OSC 8 terminal hyperlinks for supported terminals (iTerm2, WezTerm, etc.)
 */

import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { dim } from '../colors.js';
import type { CwdFormat } from '../types.js';

/**
 * Wrap text in an OSC 8 terminal hyperlink.
 * Supported by: iTerm2, WezTerm, Kitty, Hyper, Windows Terminal, VTE-based terminals.
 * Format: ESC]8;;URL ESC\ TEXT ESC]8;; ESC\
 */
function osc8Link(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Convert an absolute filesystem path to a file:// URL.
 * Handles Windows paths (C:\path -> file:///C:/path).
 */
function pathToFileUrl(absPath: string): string {
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
export function renderCwd(
  cwd: string | undefined,
  format: CwdFormat = 'relative',
  useHyperlinks = false
): string | null {
  if (!cwd) return null;

  let displayPath: string;

  switch (format) {
    case 'relative': {
      // cwd reaches here from `git rev-parse --show-toplevel` (via
      // resolveToWorktreeRoot), which emits forward slashes even on Windows,
      // while homedir() emits backslashes. Compare on normalized separators,
      // but only abbreviate when cwd is exactly home or crosses a real path
      // boundary so sibling prefixes like /Users/testuser2 do not fold to ~2.
      const home = homedir().replace(/\\/g, '/');
      const normalizedCwd = cwd.replace(/\\/g, '/');
      if (normalizedCwd === home) {
        displayPath = '~';
      } else if (normalizedCwd.startsWith(`${home}/`)) {
        displayPath = '~' + normalizedCwd.slice(home.length);
      } else {
        displayPath = cwd;
      }
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
      // Join with a literal "/" rather than join(), whose win32 separator would
      // render "parent\leaf" and break display consistency with the rest of the
      // HUD (which uses forward slashes everywhere).
      displayPath = parent ? `${parent}/${folder}` : folder;
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
