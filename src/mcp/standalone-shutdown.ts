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

function resolveParentPid(
  processRef: ShutdownProcessLike,
  overrideParentPid?: number,
): number | undefined {
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
export function registerStandaloneShutdownHandlers(
  options: RegisterStandaloneShutdownHandlersOptions
): { shutdown: (reason: string) => Promise<void> } {
  const processRef = options.processRef ?? process;
  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 1000);
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let shutdownPromise: Promise<void> | null = null;
  let parentWatch: ReturnType<typeof setInterval> | null = null;

  const stopParentWatch = (): void => {
    if (parentWatch !== null) {
      clearIntervalFn(parentWatch);
      parentWatch = null;
    }
  };

  const shutdown = async (reason: string): Promise<void> => {
    stopParentWatch();
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve(options.onShutdown(reason));
    }
    return shutdownPromise;
  };

  const register = (event: string, reason: string): void => {
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
    (parentWatch as { unref?: () => void }).unref?.();
  }

  return { shutdown };
}
