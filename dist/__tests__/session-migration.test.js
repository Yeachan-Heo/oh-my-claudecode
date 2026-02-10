import { describe, it, expect, vi, beforeEach } from 'vitest';
// Must mock state-manager before importing session-manager
vi.mock('../features/state-manager/index.js', () => ({
    readState: vi.fn(),
    writeState: vi.fn(),
    clearState: vi.fn(),
    clearStateCache: vi.fn(),
    StateLocation: { LOCAL: 'local', GLOBAL: 'global' },
}));
// Mock other deps to avoid side effects
vi.mock('../analytics/token-tracker.js', () => ({
    getTokenTracker: vi.fn(() => ({ loadSessionStats: vi.fn() })),
}));
vi.mock('../hooks/omc-orchestrator/index.js', () => ({
    getGitDiffStats: vi.fn(() => []),
}));
import { readState, writeState, clearState, StateLocation } from '../features/state-manager/index.js';
import { SessionManager } from '../analytics/session-manager.js';
describe('SessionManager migration', () => {
    let manager;
    beforeEach(() => {
        vi.clearAllMocks();
        manager = new SessionManager();
    });
    it('migrates local history to global when only local exists', async () => {
        const localData = { sessions: [{ id: 's1' }], totalSessions: 1, totalCost: 0, averageDuration: 0, successRate: 0, lastUpdated: '2026-01-01' };
        vi.mocked(readState).mockImplementation((name, location) => {
            if (name === 'session-history' && location === StateLocation.LOCAL) {
                return { exists: true, data: localData, foundAt: '/local', legacyLocations: [] };
            }
            if (name === 'session-history' && location === StateLocation.GLOBAL) {
                return { exists: false, legacyLocations: [] };
            }
            // current-session reads
            return { exists: false, legacyLocations: [] };
        });
        vi.mocked(writeState).mockReturnValue({ success: true, path: '/global' });
        await manager.getHistory();
        expect(writeState).toHaveBeenCalledWith('session-history', localData, StateLocation.GLOBAL);
        expect(clearState).toHaveBeenCalledWith('session-history', StateLocation.LOCAL);
    });
    it('merges and deduplicates when both exist', async () => {
        const localData = { sessions: [{ id: 's1' }, { id: 's2' }], totalSessions: 2, totalCost: 0, averageDuration: 0, successRate: 0, lastUpdated: '2026-01-01' };
        const globalData = { sessions: [{ id: 's1' }, { id: 's3' }], totalSessions: 2, totalCost: 0, averageDuration: 0, successRate: 0, lastUpdated: '2026-01-01' };
        vi.mocked(readState).mockImplementation((name, location) => {
            if (name === 'session-history' && location === StateLocation.LOCAL) {
                return { exists: true, data: localData, foundAt: '/local', legacyLocations: [] };
            }
            if (name === 'session-history' && location === StateLocation.GLOBAL) {
                return { exists: true, data: globalData, foundAt: '/global', legacyLocations: [] };
            }
            return { exists: false, legacyLocations: [] };
        });
        vi.mocked(writeState).mockReturnValue({ success: true, path: '/global' });
        await manager.getHistory();
        // Should merge: s1, s3 from global + s2 from local (s1 deduped)
        const writeCall = vi.mocked(writeState).mock.calls.find(c => c[0] === 'session-history' && c[2] === StateLocation.GLOBAL);
        expect(writeCall).toBeDefined();
        const mergedData = writeCall[1];
        expect(mergedData.sessions).toHaveLength(3);
        expect(mergedData.totalSessions).toBe(3);
    });
    it('does not clear local on write failure', async () => {
        const localData = { sessions: [{ id: 's1' }], totalSessions: 1, totalCost: 0, averageDuration: 0, successRate: 0, lastUpdated: '2026-01-01' };
        vi.mocked(readState).mockImplementation((name, location) => {
            if (name === 'session-history' && location === StateLocation.LOCAL) {
                return { exists: true, data: localData, foundAt: '/local', legacyLocations: [] };
            }
            if (name === 'session-history' && location === StateLocation.GLOBAL) {
                return { exists: false, legacyLocations: [] };
            }
            return { exists: false, legacyLocations: [] };
        });
        vi.mocked(writeState).mockReturnValue({ success: false, path: '/global', error: 'disk full' });
        await manager.getHistory();
        // clearState should NOT have been called for session-history since write failed
        const clearCalls = vi.mocked(clearState).mock.calls.filter(c => c[0] === 'session-history');
        expect(clearCalls).toHaveLength(0);
    });
    it('overwrites global current-session when local is newer', async () => {
        const localSession = { id: 's1', startTime: '2026-01-02T00:00:00Z', status: 'active', projectPath: '/p', goals: [], tags: [], outcomes: [], notes: '' };
        const globalSession = { id: 's1', startTime: '2026-01-01T00:00:00Z', status: 'active', projectPath: '/p', goals: [], tags: [], outcomes: [], notes: '' };
        const localHistory = { sessions: [{ id: 'h1' }], totalSessions: 1, totalCost: 0, averageDuration: 0, successRate: 0, lastUpdated: '' };
        vi.mocked(readState).mockImplementation((name, location) => {
            // session-history: local must exist so migrateLocalToGlobal doesn't return early
            if (name === 'session-history' && location === StateLocation.LOCAL) {
                return { exists: true, data: localHistory, foundAt: '/local', legacyLocations: [] };
            }
            if (name === 'session-history' && location === StateLocation.GLOBAL) {
                return { exists: false, legacyLocations: [] };
            }
            if (name === 'current-session' && location === StateLocation.LOCAL) {
                return { exists: true, data: localSession, foundAt: '/local', legacyLocations: [] };
            }
            if (name === 'current-session' && location === StateLocation.GLOBAL) {
                return { exists: true, data: globalSession, foundAt: '/global', legacyLocations: [] };
            }
            return { exists: false, legacyLocations: [] };
        });
        vi.mocked(writeState).mockReturnValue({ success: true, path: '/global' });
        await manager.getHistory();
        // Local is newer — should overwrite global
        const writeCalls = vi.mocked(writeState).mock.calls.filter(c => c[0] === 'current-session');
        expect(writeCalls.length).toBeGreaterThanOrEqual(1);
        expect(writeCalls[0][1]).toEqual(localSession);
        expect(writeCalls[0][2]).toBe(StateLocation.GLOBAL);
        // Should clean up local after successful write
        const clearCalls = vi.mocked(clearState).mock.calls.filter(c => c[0] === 'current-session');
        expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    });
    it('cleans up local current-session when global is newer', async () => {
        const localSession = { id: 's1', startTime: '2026-01-01T00:00:00Z', status: 'active', projectPath: '/p', goals: [], tags: [], outcomes: [], notes: '' };
        const globalSession = { id: 's1', startTime: '2026-01-02T00:00:00Z', status: 'active', projectPath: '/p', goals: [], tags: [], outcomes: [], notes: '' };
        const localHistory = { sessions: [{ id: 'h1' }], totalSessions: 1, totalCost: 0, averageDuration: 0, successRate: 0, lastUpdated: '' };
        vi.mocked(readState).mockImplementation((name, location) => {
            // session-history: local must exist so migrateLocalToGlobal doesn't return early
            if (name === 'session-history' && location === StateLocation.LOCAL) {
                return { exists: true, data: localHistory, foundAt: '/local', legacyLocations: [] };
            }
            if (name === 'session-history' && location === StateLocation.GLOBAL) {
                return { exists: false, legacyLocations: [] };
            }
            if (name === 'current-session' && location === StateLocation.LOCAL) {
                return { exists: true, data: localSession, foundAt: '/local', legacyLocations: [] };
            }
            if (name === 'current-session' && location === StateLocation.GLOBAL) {
                return { exists: true, data: globalSession, foundAt: '/global', legacyLocations: [] };
            }
            return { exists: false, legacyLocations: [] };
        });
        vi.mocked(writeState).mockReturnValue({ success: true, path: '/global' });
        await manager.getHistory();
        // Global is newer — should NOT overwrite, just clean up local
        const writeCalls = vi.mocked(writeState).mock.calls.filter(c => c[0] === 'current-session');
        expect(writeCalls).toHaveLength(0);
        // Should clean up local
        const clearCalls = vi.mocked(clearState).mock.calls.filter(c => c[0] === 'current-session');
        expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    });
    it('does nothing when only global exists', async () => {
        const globalData = { sessions: [{ id: 's1' }], totalSessions: 1, totalCost: 0, averageDuration: 0, successRate: 0, lastUpdated: '2026-01-01' };
        vi.mocked(readState).mockImplementation((name, location) => {
            if (name === 'session-history' && location === StateLocation.GLOBAL) {
                return { exists: true, data: globalData, foundAt: '/global', legacyLocations: [] };
            }
            // LOCAL and current-session reads
            return { exists: false, legacyLocations: [] };
        });
        const history = await manager.getHistory();
        expect(history.sessions).toHaveLength(1);
        // writeState should not have been called for migration
        expect(writeState).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=session-migration.test.js.map