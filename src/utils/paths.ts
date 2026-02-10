/**
 * Cross-Platform Path Utilities
 *
 * Provides utility functions for handling paths across Windows, macOS, and Linux.
 * These utilities ensure paths in configuration files use forward slashes
 * (which work universally) and handle platform-specific directory conventions.
 */

import { join } from 'path';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';

/**
 * Convert a path to use forward slashes (for JSON/config files)
 * This is necessary because settings.json commands are executed
 * by shells that expect forward slashes even on Windows
 */
export function toForwardSlash(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Get Claude config directory path
 */
export function getClaudeConfigDir(): string {
  return join(homedir(), '.claude');
}

/**
 * Get a path suitable for use in shell commands
 * Converts backslashes to forward slashes for cross-platform compatibility
 */
export function toShellPath(path: string): string {
  const normalized = toForwardSlash(path);
  // Windows paths with spaces need quoting
  if (normalized.includes(' ')) {
    return `"${normalized}"`;
  }
  return normalized;
}

/**
 * Get Windows-appropriate data directory
 * Falls back to sensible locations instead of XDG paths
 */
export function getDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  }
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

/**
 * Get Windows-appropriate config directory
 */
export function getConfigDir(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

/**
 * Safely delete a file, ignoring ENOENT errors.
 * Prevents crashes when cleaning up files that may not exist (Bug #13 fix).
 */
export function safeUnlinkSync(filePath: string): boolean {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Safely remove a directory recursively, ignoring errors.
 */
export function safeRmSync(dirPath: string): boolean {
  try {
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
