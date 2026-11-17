export interface ShutdownProcessLike {
    once(event: string, listener: () => void): unknown;
    stdin?: {
        once(event: string, listener: () => void): unknown;
    } | null;
    ppid?: number;
}
export interface RegisterStandaloneShutdownHandlersOptions {
    onShutdown: (reason: string) => void | Promise<void>;
    processRef?: ShutdownProcessLike;
    parentPid?: number;
    pollIntervalMs?: number;
    getParentPid?: () => number | undefined;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
}
/**
 * Register MCP-server shutdown hooks for both explicit signals and the implicit
 * "parent went away" cases that background agents hit when their stdio pipes
 * are closed without forwarding SIGTERM/SIGINT.
 */
export declare function registerStandaloneShutdownHandlers(options: RegisterStandaloneShutdownHandlersOptions): {
    shutdown: (reason: string) => Promise<void>;
};
//# sourceMappingURL=standalone-shutdown.d.ts.map