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
}
/** Path callbacks are a Linux-only compatibility API. Darwin requires *at. */
export declare function containedFdPath(fd: number, platform: NodeJS.Platform, child?: string): string;
export declare function containedFsPlatformSupported(platform: NodeJS.Platform): boolean;
export declare function directoryOperations(fd: number, platform?: NodeJS.Platform): DirectoryOperations;
//# sourceMappingURL=contained-fd.d.ts.map