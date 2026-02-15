import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../analytics/query-engine.js', () => ({
    getQueryEngine: () => ({
        cleanupOldData: async () => ({ removedTokens: 11, removedMetrics: 7 }),
    }),
}));
vi.mock('../../../hud/background-cleanup.js', () => ({
    cleanupStaleBackgroundTasks: async () => 3,
}));
vi.mock('../../../tools/python-repl/bridge-manager.js', () => ({
    cleanupStaleBridges: async () => ({
        scannedSessions: 4,
        staleSessions: 2,
        activeSessions: 2,
        filesRemoved: 5,
        metaRemoved: 2,
        socketRemoved: 2,
        lockRemoved: 1,
        errors: [],
    }),
}));
import { cleanupCommand } from '../cleanup.js';
describe('cleanupCommand', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('includes stale python_repl bridge cleanup summary in output', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        await cleanupCommand({ retention: 14 });
        const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('Removed 11 old token logs (older than 14 days)');
        expect(output).toContain('Removed 7 old metric events');
        expect(output).toContain('Removed 3 stale background tasks');
        expect(output).toContain('Removed 5 stale python_repl bridge file(s) (2 stale session(s), 2 active session(s) skipped)');
    });
});
//# sourceMappingURL=cleanup.test.js.map