export interface ContainedStats {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly nlink: number;
    readonly size: number;
    readonly mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}
/** Operations are bound to an open directory; names never become write authority. */
export interface DirectoryOperations {
    open(name: string, flags: number, mode?: number): number;
    mkdir(name: string, mode?: number): void;
    lstat(name: string): ContainedStats;
    rename(source: string, destination: string): void;
    unlink(name: string): void;
    link(source: string, destination: string): void;
    readDir(): string[];
    realpath(): string;
    sync(): void;
    /** Removes an empty directory relative to this one. Absent where the platform has no such operation (the native module has none). */
    rmdir?(name: string): void;
}
/** Path callbacks are a Linux-only compatibility API. Darwin requires *at. */
export declare function containedFdPath(fd: number, platform: NodeJS.Platform, child?: string): string;
export declare function containedFsPlatformSupported(platform: NodeJS.Platform): boolean;
export declare function directoryOperations(fd: number, platform?: NodeJS.Platform): DirectoryOperations;
/** Operations for an open directory, or null where the platform has none: no pathname fallback is offered. */
export declare function directoryOperationsIfSupported(fd: number, platform?: NodeJS.Platform): DirectoryOperations | null;
//# sourceMappingURL=contained-fd.d.ts.map