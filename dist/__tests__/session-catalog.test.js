import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('fs/promises', () => ({
    readFile: vi.fn(),
}));
// Mock cost-estimator to return deterministic costs
vi.mock('../analytics/cost-estimator.js', () => ({
    calculateCost: vi.fn((input) => ({
        inputCost: input.inputTokens * 0.000003,
        outputCost: input.outputTokens * 0.000015,
        cacheWriteCost: 0,
        cacheReadCost: 0,
        totalCost: input.inputTokens * 0.000003 + input.outputTokens * 0.000015,
    })),
}));
import { readFile } from 'fs/promises';
import { SessionCatalog, isValidTokenUsage } from '../analytics/session-catalog.js';
const mockedReadFile = vi.mocked(readFile);
const mockLine = (sessionId, timestamp, model, input, output, cacheCreation = 0, cacheRead = 0, agentName) => JSON.stringify({
    sessionId,
    timestamp,
    modelName: model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    ...(agentName ? { agentName } : {}),
});
const mockData = [
    mockLine('s1', '2026-01-01T00:00:00Z', 'claude-sonnet-4.5', 100, 50, 10, 5),
    mockLine('s1', '2026-01-01T01:00:00Z', 'claude-sonnet-4.5', 200, 100, 20, 10),
    mockLine('s2', '2026-01-02T00:00:00Z', 'claude-haiku-4', 50, 25, 5, 2),
].join('\n');
describe('SessionCatalog', () => {
    let catalog;
    beforeEach(() => {
        vi.clearAllMocks();
        catalog = new SessionCatalog();
    });
    describe('getSessions', () => {
        it('should group records by sessionId and sort newest first', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const sessions = await catalog.getSessions();
            expect(sessions).toHaveLength(2);
            // s2 is newest (2026-01-02), should come first
            expect(sessions[0].sessionId).toBe('s2');
            expect(sessions[1].sessionId).toBe('s1');
        });
        it('should compute correct cost and token totals', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const sessions = await catalog.getSessions();
            // s1 has 2 entries: (100+50) + (200+100) = 450 tokens
            const s1 = sessions.find(s => s.sessionId === 's1');
            expect(s1.totalTokens).toBe(450);
            expect(s1.entryCount).toBe(2);
            expect(s1.totalCost).toBeGreaterThan(0);
            // s2 has 1 entry: 50+25 = 75 tokens
            const s2 = sessions.find(s => s.sessionId === 's2');
            expect(s2.totalTokens).toBe(75);
            expect(s2.entryCount).toBe(1);
        });
        it('should apply limit', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const sessions = await catalog.getSessions(1);
            expect(sessions).toHaveLength(1);
            expect(sessions[0].sessionId).toBe('s2'); // newest first
        });
        it('should return empty array for empty file', async () => {
            mockedReadFile.mockResolvedValue('');
            const sessions = await catalog.getSessions();
            expect(sessions).toEqual([]);
        });
        it('should return empty array for non-existent file', async () => {
            const err = new Error('ENOENT');
            err.code = 'ENOENT';
            mockedReadFile.mockRejectedValue(err);
            const sessions = await catalog.getSessions();
            expect(sessions).toEqual([]);
        });
        it('should skip malformed JSONL lines gracefully', async () => {
            const dataWithBadLines = [
                'not json at all',
                mockLine('s1', '2026-01-01T00:00:00Z', 'claude-sonnet-4.5', 100, 50, 10, 5),
                '{invalid json',
                '{"sessionId":"missing-fields"}',
                mockLine('s2', '2026-01-02T00:00:00Z', 'claude-haiku-4', 50, 25, 5, 2),
            ].join('\n');
            mockedReadFile.mockResolvedValue(dataWithBadLines);
            const sessions = await catalog.getSessions();
            expect(sessions).toHaveLength(2);
        });
        it('should filter out records with missing required fields', async () => {
            const dataWithInvalid = [
                mockLine('s1', '2026-01-01T00:00:00Z', 'claude-sonnet-4.5', 100, 50, 10, 5),
                // Valid JSON but missing required fields - not a valid TokenUsage
                JSON.stringify({ sessionId: 's3', timestamp: '2026-01-03T00:00:00Z' }),
            ].join('\n');
            mockedReadFile.mockResolvedValue(dataWithInvalid);
            const sessions = await catalog.getSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0].sessionId).toBe('s1');
        });
    });
    describe('getSession', () => {
        it('should return correct session by id', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const session = await catalog.getSession('s1');
            expect(session).not.toBeNull();
            expect(session.sessionId).toBe('s1');
            expect(session.entryCount).toBe(2);
        });
        it('should return null for unknown id', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const session = await catalog.getSession('nonexistent');
            expect(session).toBeNull();
        });
    });
    describe('getSessionCount', () => {
        it('should return unique session count', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const count = await catalog.getSessionCount();
            expect(count).toBe(2);
        });
        it('should return 0 for empty data', async () => {
            mockedReadFile.mockResolvedValue('');
            const count = await catalog.getSessionCount();
            expect(count).toBe(0);
        });
    });
    describe('buildCatalogSession (via getSessions)', () => {
        it('should compute correct startTime and endTime', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const sessions = await catalog.getSessions();
            const s1 = sessions.find(s => s.sessionId === 's1');
            expect(s1.startTime).toBe('2026-01-01T00:00:00Z');
            expect(s1.endTime).toBe('2026-01-01T01:00:00Z');
        });
        it('should set source to runtime', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const sessions = await catalog.getSessions();
            for (const session of sessions) {
                expect(session.source).toBe('runtime');
            }
        });
        it('should build model breakdown', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const sessions = await catalog.getSessions();
            const s1 = sessions.find(s => s.sessionId === 's1');
            expect(s1.modelBreakdown['claude-sonnet-4.5']).toBeDefined();
            expect(s1.modelBreakdown['claude-sonnet-4.5'].tokens).toBe(450);
        });
        it('should use (main session) for entries without agentName', async () => {
            mockedReadFile.mockResolvedValue(mockData);
            const sessions = await catalog.getSessions();
            const s1 = sessions.find(s => s.sessionId === 's1');
            expect(s1.agentBreakdown['(main session)']).toBeDefined();
        });
    });
});
describe('isValidTokenUsage', () => {
    it('should return true for valid records', () => {
        expect(isValidTokenUsage({
            sessionId: 's1',
            timestamp: '2026-01-01T00:00:00Z',
            modelName: 'claude-sonnet-4.5',
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 10,
            cacheReadTokens: 5,
        })).toBe(true);
    });
    it('should return false for null', () => {
        expect(isValidTokenUsage(null)).toBe(false);
    });
    it('should return false for non-object', () => {
        expect(isValidTokenUsage('string')).toBe(false);
    });
    it('should return false for missing fields', () => {
        expect(isValidTokenUsage({
            sessionId: 's1',
            timestamp: '2026-01-01T00:00:00Z',
        })).toBe(false);
    });
    it('should return false for wrong field types', () => {
        expect(isValidTokenUsage({
            sessionId: 's1',
            timestamp: '2026-01-01T00:00:00Z',
            modelName: 'claude-sonnet-4.5',
            inputTokens: '100', // string instead of number
            outputTokens: 50,
            cacheCreationTokens: 10,
            cacheReadTokens: 5,
        })).toBe(false);
    });
});
//# sourceMappingURL=session-catalog.test.js.map