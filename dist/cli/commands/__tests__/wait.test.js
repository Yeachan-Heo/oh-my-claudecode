import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({
    checkRateLimitStatus: vi.fn(),
    formatRateLimitStatus: vi.fn(),
    isRateLimitStatusDegraded: vi.fn(),
    isTmuxAvailable: vi.fn(),
    isInsideTmux: vi.fn(),
    getDaemonStatus: vi.fn(),
    startDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    detectBlockedPanes: vi.fn(),
    runDaemonForeground: vi.fn(),
    isDaemonRunning: vi.fn(),
}));
vi.mock('../../../features/rate-limit-wait/index.js', () => boundary);
import { waitCommand, waitDetectCommand } from '../wait.js';
describe('wait command degraded usage heading', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        boundary.checkRateLimitStatus.mockResolvedValue({
            isLimited: false,
            apiErrorReason: 'network',
            usingStaleData: true,
        });
        boundary.formatRateLimitStatus.mockReturnValue('Usage API network error; showing stale cached usage');
        boundary.isRateLimitStatusDegraded.mockReturnValue(true);
        boundary.isTmuxAvailable.mockReturnValue(false);
        boundary.isDaemonRunning.mockReturnValue(false);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('does not label a stale network failure as API rate limiting', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await waitCommand({});
        const output = log.mock.calls.map(([message]) => String(message)).join('\n');
        expect(output).toContain('Usage Data Stale');
        expect(output).not.toContain('Usage API Rate Limited');
        expect(output).toContain('Usage API network error; showing stale cached usage');
    });
    it('keeps the rate-limit heading for 429 responses', async () => {
        boundary.checkRateLimitStatus.mockResolvedValue({
            isLimited: false,
            apiErrorReason: 'rate_limited',
            usingStaleData: true,
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await waitCommand({});
        const output = log.mock.calls.map(([message]) => String(message)).join('\n');
        expect(output).toContain('Usage API Rate Limited');
    });
});
describe('wait detect --json', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        boundary.isTmuxAvailable.mockReturnValue(true);
        boundary.detectBlockedPanes.mockResolvedValue({
            success: true,
            message: 'No blocked Claude Code sessions detected.',
            state: { isRunning: false, pid: null, blockedPanes: [] },
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('prints only the JSON result on stdout', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await waitDetectCommand({ json: true, lines: 15 });
        const output = log.mock.calls.map(([message]) => String(message)).join('\n');
        expect(JSON.parse(output)).toEqual({
            success: true,
            message: 'No blocked Claude Code sessions detected.',
            state: { isRunning: false, pid: null, blockedPanes: [] },
        });
        expect(boundary.detectBlockedPanes).toHaveBeenCalledWith({ paneLinesToCapture: 15 });
    });
    it('keeps the scanning line in text mode', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await waitDetectCommand({ lines: 15 });
        const output = log.mock.calls.map(([message]) => String(message)).join('\n');
        expect(output).toContain('Scanning for blocked Claude Code sessions...');
        expect(output).toContain('No blocked Claude Code sessions detected.');
    });
});
//# sourceMappingURL=wait.test.js.map