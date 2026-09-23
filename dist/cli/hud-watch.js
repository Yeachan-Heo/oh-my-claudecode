import { InvalidArgumentError } from 'commander';
import { registerStandaloneShutdownHandlers } from '../mcp/standalone-shutdown.js';
/** Largest delay Node.js timers preserve without overflowing to 1 ms. */
export const MAX_HUD_WATCH_INTERVAL_MS = 2_147_483_647;
export function parseHudWatchInterval(value) {
    const normalized = value.trim();
    const intervalMs = Number(normalized);
    if (!/^\d+$/.test(normalized) ||
        !Number.isSafeInteger(intervalMs) ||
        intervalMs < 1 ||
        intervalMs > MAX_HUD_WATCH_INTERVAL_MS) {
        throw new InvalidArgumentError(`must be an integer between 1 and ${MAX_HUD_WATCH_INTERVAL_MS} milliseconds`);
    }
    return intervalMs;
}
/**
 * Run the HUD in watch mode until an explicit shutdown signal or parent-exit
 * condition is observed.
 */
export async function runHudWatchLoop(options) {
    const registerShutdownHandlers = options.registerShutdownHandlers ?? registerStandaloneShutdownHandlers;
    let skipInit = false;
    let shouldStop = false;
    let wakeSleep = null;
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
        await new Promise((resolve) => {
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
//# sourceMappingURL=hud-watch.js.map