/**
 * Platform Detection and Utilities
 * Central module for all platform-specific code.
 */

import * as path from 'path';
import { readFileSync } from 'fs';

export const PLATFORM = process.platform;

export function isWindows(): boolean {
  return PLATFORM === 'win32';
}

export function isMacOS(): boolean {
  return PLATFORM === 'darwin';
}

export function isLinux(): boolean {
  return PLATFORM === 'linux';
}

export function isUnix(): boolean {
  return isMacOS() || isLinux();
}

/**
 * Check if a path is the filesystem root
 * Works on both Unix (/) and Windows (C:\)
 */
export function isPathRoot(filepath: string): boolean {
  const parsed = path.parse(filepath);
  return parsed.root === filepath;
}

/**
 * Check if running inside WSL (Windows Subsystem for Linux).
 * Checks WSLENV env var OR /proc/version containing "microsoft".
 */
export function isWSL(): boolean {
  if (process.env.WSLENV !== undefined) {
    return true;
  }
  try {
    const procVersion = readFileSync('/proc/version', 'utf8');
    return procVersion.toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

// Re-exports
export * from './process-utils.js';
