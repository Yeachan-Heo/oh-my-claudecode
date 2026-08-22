import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHudWatchLoop } from '../hud-watch.js';
describe('runHudWatchLoop', () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    it('stops the watch loop when shutdown is requested', async () => {
        let shutdownHandler;
        const registerShutdownHandlers = vi.fn((options) => {
            const onShutdown = async (reason) => {
                await options.onShutdown(reason);
            };
            shutdownHandler = onShutdown;
            return { shutdown: onShutdown };
        });
        const hudMain = vi.fn(async () => {
            await shutdownHandler?.('SIGTERM');
        });
        await runHudWatchLoop({
            intervalMs: 1_000,
            hudMain,
            registerShutdownHandlers,
        });
        expect(hudMain).toHaveBeenCalledTimes(1);
        expect(hudMain).toHaveBeenNthCalledWith(1, true, false);
    });
    it('uses skipInit=true after the first iteration', async () => {
        vi.useFakeTimers();
        let shutdownHandler;
        const registerShutdownHandlers = vi.fn((options) => {
            const onShutdown = async (reason) => {
                await options.onShutdown(reason);
            };
            shutdownHandler = onShutdown;
            return { shutdown: onShutdown };
        });
        const hudMain = vi.fn(async () => {
            if (hudMain.mock.calls.length === 2) {
                await shutdownHandler?.('SIGTERM');
            }
        });
        const loopPromise = runHudWatchLoop({
            intervalMs: 1_000,
            hudMain,
            registerShutdownHandlers,
        });
        await vi.waitFor(() => {
            expect(hudMain).toHaveBeenCalledTimes(1);
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await loopPromise;
        expect(hudMain).toHaveBeenNthCalledWith(1, true, false);
        expect(hudMain).toHaveBeenNthCalledWith(2, true, true);
    });
    it('keeps the polling timer referenced while watch mode is active', async () => {
        const intervalMs = 60_000;
        let shutdownHandler;
        const registerShutdownHandlers = vi.fn((options) => {
            const onShutdown = async (reason) => {
                await options.onShutdown(reason);
            };
            shutdownHandler = onShutdown;
            return { shutdown: onShutdown };
        });
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const loopPromise = runHudWatchLoop({
            intervalMs,
            hudMain: vi.fn(async () => { }),
            registerShutdownHandlers,
        });
        try {
            await vi.waitFor(() => {
                expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === intervalMs)).toBe(true);
            });
            const pollingTimers = setTimeoutSpy.mock.calls.flatMap(([, delay], index) => delay === intervalMs
                ? [setTimeoutSpy.mock.results[index]?.value]
                : []);
            expect(pollingTimers).toHaveLength(1);
            expect(pollingTimers[0]?.hasRef()).toBe(true);
        }
        finally {
            await shutdownHandler?.('SIGTERM');
            await loopPromise;
            setTimeoutSpy.mockRestore();
        }
    });
});
//# sourceMappingURL=hud-watch.test.js.map