export interface NativeContainedFs {
    openAt(directoryFd: number, name: string, flags: number, mode: number): number;
    mkdirAt(directoryFd: number, name: string, mode: number): void;
    statAt(directoryFd: number, name: string): {
        dev: number;
        ino: number;
        mode: number;
        nlink: number;
        size: number;
        mtimeMs: number;
    };
    renameAt(directoryFd: number, source: string, destination: string): void;
    unlinkAt(directoryFd: number, name: string): void;
    linkAt(directoryFd: number, source: string, destination: string): void;
    readDir(directoryFd: number): string[];
    /** For containment checks only. Never use this path for a mutation. */
    realpathFd(fd: number): string;
    /** Read the kernel process birth time; null means unavailable or not found. */
    processStartTime(pid: number): {
        seconds: number;
        microseconds: number;
    } | null;
}
/** Resolve from this installed module, including the bridge CJS import.meta polyfill. */
export declare function getNativeContainedFs(): NativeContainedFs;
//# sourceMappingURL=native-contained-fs.d.ts.map