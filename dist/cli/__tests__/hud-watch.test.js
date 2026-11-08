import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_HUD_WATCH_INTERVAL_MS, parseHudWatchInterval, runHudWatchLoop, } from '../hud-watch.js';
const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
process.env.OMC_CLI_SKIP_PARSE = '1';
afterAll(() => {
    if (originalSkipParse === undefined)
        delete process.env.OMC_CLI_SKIP_PARSE;
    else
        process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
});
describe('parseHudWatchInterval', () => {
    it.each([
        ['1', 1],
        ['250', 250],
        [' 1000 ', 1_000],
        [String(MAX_HUD_WATCH_INTERVAL_MS), MAX_HUD_WATCH_INTERVAL_MS],
    ])('parses %j as %i milliseconds', (raw, expected) => {
        expect(parseHudWatchInterval(raw)).toBe(expected);
    });
    it.each([
        '',
        '0',
        '-1',
        '1.5',
        '100ms',
        'abc',
        String(MAX_HUD_WATCH_INTERVAL_MS + 1),
        String(Number.MAX_SAFE_INTEGER),
        `${Number.MAX_SAFE_INTEGER}0`,
    ])('rejects invalid interval %j', (raw) => {
        expect(() => parseHudWatchInterval(raw)).toThrow(`must be an integer between 1 and ${MAX_HUD_WATCH_INTERVAL_MS} milliseconds`);
    });
});
describe('HUD interval Commander integration', () => {
    it('uses a numeric default and rejects invalid input before the action', async () => {
        vi.resetModules();
        const { buildProgram } = await import('../index.js');
        const program = buildProgram();
        const hudCommand = program.commands.find((command) => command.name() === 'hud');
        const intervalOption = hudCommand?.options.find((option) => option.long === '--interval');
        expect(hudCommand).toBeDefined();
        expect(intervalOption).toBeDefined();
        expect(intervalOption?.defaultValue).toBe(1_000);
        expect(typeof intervalOption?.defaultValue).toBe('number');
        expect(intervalOption?.parseArg?.('250', intervalOption.defaultValue)).toBe(250);
        expect(hudCommand?.helpInformation()).toContain('--interval <ms>');
        program.configureOutput({ writeErr: () => undefined });
        program.exitOverride();
        hudCommand?.exitOverride();
        await expect(program.parseAsync(['node', 'omc', 'hud', '--interval', '0'], { from: 'node' })).rejects.toMatchObject({
            code: 'commander.invalidArgument',
            exitCode: 1,
        });
    });
});
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