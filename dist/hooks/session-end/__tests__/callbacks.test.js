import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatSessionSummary, interpolatePath, triggerStopCallbacks } from '../callbacks.js';
// Mock auto-update module
vi.mock('../../../features/auto-update.js', () => ({
    getOMCConfig: vi.fn(() => ({
        silentAutoUpdate: false,
        stopHookCallbacks: undefined,
    })),
}));
// Mock fs module
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});
// Import mocked modules
import { getOMCConfig } from '../../../features/auto-update.js';
import { writeFileSync, mkdirSync } from 'fs';
const mockGetConfig = vi.mocked(getOMCConfig);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
function createTestMetrics(overrides) {
    return {
        session_id: 'test-session-123',
        started_at: '2026-02-04T10:00:00.000Z',
        ended_at: '2026-02-04T11:00:00.000Z',
        reason: 'clear',
        duration_ms: 3600000, // 1 hour
        agents_spawned: 5,
        agents_completed: 4,
        modes_used: ['ultrawork'],
        ...overrides,
    };
}
describe('formatSessionSummary', () => {
    it('formats markdown summary with all fields', () => {
        const metrics = createTestMetrics();
        const summary = formatSessionSummary(metrics);
        expect(summary).toContain('test-session-123');
        expect(summary).toContain('60m 0s');
        expect(summary).toContain('clear');
        expect(summary).toContain('5');
        expect(summary).toContain('4');
    });
    it('handles unknown duration', () => {
        const metrics = createTestMetrics({ duration_ms: undefined });
        const summary = formatSessionSummary(metrics);
        expect(summary).toContain('unknown');
    });
    it('handles no modes used', () => {
        const metrics = createTestMetrics({ modes_used: [] });
        const summary = formatSessionSummary(metrics);
        expect(summary).toContain('none');
    });
    it('formats JSON summary', () => {
        const metrics = createTestMetrics();
        const summary = formatSessionSummary(metrics, 'json');
        const parsed = JSON.parse(summary);
        expect(parsed.session_id).toBe('test-session-123');
        expect(parsed.duration_ms).toBe(3600000);
    });
    it('formats short durations correctly', () => {
        const metrics = createTestMetrics({ duration_ms: 90000 }); // 1m 30s
        const summary = formatSessionSummary(metrics);
        expect(summary).toContain('1m 30s');
    });
});
describe('interpolatePath', () => {
    it('replaces {session_id} placeholder', () => {
        const result = interpolatePath('/tmp/{session_id}.md', 'abc-123');
        expect(result).toBe('/tmp/abc-123.md');
    });
    it('replaces {date} placeholder', () => {
        const result = interpolatePath('/tmp/{date}.md', 'session-1');
        // Date should be YYYY-MM-DD format
        expect(result).toMatch(/\/tmp\/\d{4}-\d{2}-\d{2}\.md/);
    });
    it('replaces {time} placeholder', () => {
        const result = interpolatePath('/tmp/{time}.md', 'session-1');
        // Time should be HH-MM-SS format
        expect(result).toMatch(/\/tmp\/\d{2}-\d{2}-\d{2}\.md/);
    });
    it('replaces ~ with homedir', () => {
        const result = interpolatePath('~/logs/test.md', 'session-1');
        expect(result).not.toContain('~');
        expect(result).toContain('/logs/test.md');
    });
    it('replaces multiple placeholders', () => {
        const result = interpolatePath('/tmp/{date}/{session_id}.md', 'my-session');
        expect(result).toContain('my-session');
        expect(result).toMatch(/\/tmp\/\d{4}-\d{2}-\d{2}\/my-session\.md/);
    });
    it('handles paths without placeholders', () => {
        const result = interpolatePath('/tmp/fixed-path.md', 'session-1');
        expect(result).toBe('/tmp/fixed-path.md');
    });
});
describe('triggerStopCallbacks', () => {
    const testInput = { session_id: 'test-session-123', cwd: '/tmp/test' };
    beforeEach(() => {
        vi.resetAllMocks();
    });
    it('does nothing when no callbacks configured', async () => {
        mockGetConfig.mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: undefined,
        });
        const metrics = createTestMetrics();
        await triggerStopCallbacks(metrics, testInput);
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
    it('does nothing when callbacks object is empty', async () => {
        mockGetConfig.mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: {},
        });
        const metrics = createTestMetrics();
        await triggerStopCallbacks(metrics, testInput);
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
    it('writes file when file callback is enabled', async () => {
        mockGetConfig.mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: {
                file: {
                    enabled: true,
                    path: '/tmp/test-{session_id}.md',
                },
            },
        });
        const metrics = createTestMetrics();
        await triggerStopCallbacks(metrics, testInput);
        expect(mockMkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
        expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/test-test-session-123.md', expect.stringContaining('test-session-123'), { encoding: 'utf-8', mode: 0o600 });
    });
    it('writes JSON format when configured', async () => {
        mockGetConfig.mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: {
                file: {
                    enabled: true,
                    path: '/tmp/test.json',
                    format: 'json',
                },
            },
        });
        const metrics = createTestMetrics();
        await triggerStopCallbacks(metrics, testInput);
        expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/test.json', expect.stringContaining('"session_id"'), { encoding: 'utf-8', mode: 0o600 });
    });
    it('skips disabled file callback', async () => {
        mockGetConfig.mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: {
                file: {
                    enabled: false,
                    path: '/tmp/test.md',
                },
            },
        });
        const metrics = createTestMetrics();
        await triggerStopCallbacks(metrics, testInput);
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
    it('handles file write errors gracefully', async () => {
        mockMkdirSync.mockImplementation(() => {
            throw new Error('Permission denied');
        });
        mockGetConfig.mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: {
                file: {
                    enabled: true,
                    path: '/root/protected/test.md',
                },
            },
        });
        const metrics = createTestMetrics();
        // Should not throw
        await expect(triggerStopCallbacks(metrics, testInput)).resolves.not.toThrow();
    });
});
//# sourceMappingURL=callbacks.test.js.map