function resolveParentPid(processRef, overrideParentPid) {
    if (typeof overrideParentPid === 'number') {
        return overrideParentPid;
    }
    if (typeof processRef.ppid === 'number') {
        return processRef.ppid;
    }
    if (typeof process.ppid === 'number') {
        return process.ppid;
    }
    return undefined;
}
/**
 * Register MCP-server shutdown hooks for both explicit signals and the implicit
 * "parent went away" cases that background agents hit when their stdio pipes
 * are closed without forwarding SIGTERM/SIGINT.
 */
export function registerStandaloneShutdownHandlers(options) {
    const processRef = options.processRef ?? process;
    const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 1000);
    const setIntervalFn = options.setIntervalFn ?? setInterval;
    const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    let shutdownPromise = null;
    let parentWatch = null;
    const stopParentWatch = () => {
        if (parentWatch !== null) {
            clearIntervalFn(parentWatch);
            parentWatch = null;
        }
    };
    const shutdown = async (reason) => {
        stopParentWatch();
        if (!shutdownPromise) {
            shutdownPromise = Promise.resolve(options.onShutdown(reason));
        }
        return shutdownPromise;
    };
    const register = (event, reason) => {
        processRef.once(event, () => {
            void shutdown(reason);
        });
    };
    register('SIGTERM', 'SIGTERM');
    register('SIGINT', 'SIGINT');
    register('disconnect', 'parent disconnect');
    processRef.stdin?.once('end', () => {
        void shutdown('stdin end');
    });
    processRef.stdin?.once('close', () => {
        void shutdown('stdin close');
    });
    const expectedParentPid = resolveParentPid(processRef, options.parentPid);
    if (typeof expectedParentPid === 'number' && expectedParentPid > 1) {
        const getParentPid = options.getParentPid ?? (() => resolveParentPid(processRef));
        parentWatch = setIntervalFn(() => {
            const currentParentPid = getParentPid();
            if (typeof currentParentPid !== 'number') {
                return;
            }
            if (currentParentPid <= 1 || currentParentPid !== expectedParentPid) {
                void shutdown(`parent pid changed (${expectedParentPid} -> ${currentParentPid})`);
            }
        }, pollIntervalMs);
        parentWatch.unref?.();
    }
    return { shutdown };
}
//# sourceMappingURL=standalone-shutdown.js.map