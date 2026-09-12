/**
 * Return the kernel-provided path for an already-open directory FD.
 *
 * Both Linux procfs and Darwin devfs resolve the descriptor at lookup time,
 * so the returned path remains anchored to the opened directory rather than
 * to its mutable pathname. No pathname fallback is provided.
 */
export declare function containedFdPath(directoryFd: number, platform: NodeJS.Platform, child?: string): string;
export declare function containedFsPlatformSupported(platform: NodeJS.Platform): boolean;
//# sourceMappingURL=contained-fd.d.ts.map