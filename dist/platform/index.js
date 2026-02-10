/**
 * Platform Detection and Utilities
 * Central module for all platform-specific code.
 */
import * as path from 'path';
export const PLATFORM = process.platform;
export function isWindows() {
    return PLATFORM === 'win32';
}
export function isMacOS() {
    return PLATFORM === 'darwin';
}
export function isLinux() {
    return PLATFORM === 'linux';
}
export function isUnix() {
    return isMacOS() || isLinux();
}
/**
 * Check if a path is the filesystem root
 * Works on both Unix (/) and Windows (C:\)
 */
export function isPathRoot(filepath) {
    const parsed = path.parse(filepath);
    return parsed.root === filepath;
}
// Re-exports
export * from './process-utils.js';
//# sourceMappingURL=index.js.map