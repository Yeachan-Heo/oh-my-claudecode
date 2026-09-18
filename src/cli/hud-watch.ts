import { InvalidArgumentError } from 'commander';
import { registerStandaloneShutdownHandlers } from '../mcp/standalone-shutdown.js';

export interface HudMainLike {
  (watchMode: boolean, skipInit?: boolean): Promise<void>;
}

export interface HudWatchLoopOptions {
  intervalMs: number;
  hudMain: HudMainLike;
  registerShutdownHandlers?: typeof registerStandaloneShutdownHandlers;
}

export function parseHudWatchInterval(value: string): number {
  const normalized = value.trim();
  const intervalMs = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new InvalidArgumentError('must be a positive integer in milliseconds');
  }

  return intervalMs;
}

/**
 * Run the HUD in watch mode until an explicit shutdown signal or parent-exit
 * condition is observed.
 */
export async function runHudWatchLoop(options: HudWatchLoopOptions): Promise<void> {
  const registerShutdownHandlers = options.registerShutdownHandlers ?? registerStandaloneShutdownHandlers;
  let skipInit = false;
  let shouldStop = false;
  let wakeSleep: (() => void) | null = null;

  registerShutdownHandlers({
    onShutdown: async () => {
      shouldStop = true;
      wakeSleep?.();
    },
  });

  while (!shouldStop) {
    await options.hudMain(true, skipInit);
    skipInit = true;

    if (shouldStop) {
      break;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, options.intervalMs);

      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
    });
  }
}
