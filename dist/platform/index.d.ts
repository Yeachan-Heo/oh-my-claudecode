/**
 * Platform Detection and Utilities
 * Central module for all platform-specific code.
 */
export declare const PLATFORM: NodeJS.Platform;
export declare function isWindows(): boolean;
export declare function isMacOS(): boolean;
export declare function isLinux(): boolean;
export declare function isUnix(): boolean;
/**
 * Check if a path is the filesystem root
 * Works on both Unix (/) and Windows (C:\)
 */
export declare function isPathRoot(filepath: string): boolean;
export * from './process-utils.js';
//# sourceMappingURL=index.d.ts.map