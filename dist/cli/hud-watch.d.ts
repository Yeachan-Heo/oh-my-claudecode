import { registerStandaloneShutdownHandlers } from '../mcp/standalone-shutdown.js';
export interface HudMainLike {
    (watchMode: boolean, skipInit?: boolean): Promise<void>;
}
export interface HudWatchLoopOptions {
    intervalMs: number;
    hudMain: HudMainLike;
    registerShutdownHandlers?: typeof registerStandaloneShutdownHandlers;
}
/** Largest delay Node.js timers preserve without overflowing to 1 ms. */
export declare const MAX_HUD_WATCH_INTERVAL_MS = 2147483647;
export declare function parseHudWatchInterval(value: string): number;
/**
 * Run the HUD in watch mode until an explicit shutdown signal or parent-exit
 * condition is observed.
 */
export declare function runHudWatchLoop(options: HudWatchLoopOptions): Promise<void>;
//# sourceMappingURL=hud-watch.d.ts.map