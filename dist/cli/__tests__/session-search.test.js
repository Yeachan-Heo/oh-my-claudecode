import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatSessionSearchReport, sessionSearchCommand, } from '../commands/session-search.js';
import { formatSessionFrictionReport, sessionFrictionReportCommand, } from '../commands/session-friction-report.js';
import { encodeProjectPath } from '../../utils/encode-project-path.js';
function writeTranscript(filePath, entries) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}
describe('session search cli command', () => {
    const repoRoot = process.cwd();
    let tempRoot;
    let claudeDir;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-session-search-cli-'));
        claudeDir = join(tempRoot, 'claude');
        process.env.CLAUDE_CONFIG_DIR = claudeDir;
        process.env.OMC_STATE_DIR = join(tempRoot, 'omc-state');
        writeTranscript(join(claudeDir, 'projects', encodeProjectPath(repoRoot), 'session-current.jsonl'), [
            {
                sessionId: 'session-current',
                cwd: repoRoot,
                type: 'assistant',
                timestamp: '2026-03-09T10:05:00.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'We traced the notify-hook regression to stale team leader state in a prior run.' }] },
            },
        ]);
    });
    afterEach(() => {
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.OMC_STATE_DIR;
        // Windows can throw ENOTEMPTY on rmdir when handles/indexing linger;
        // retry to avoid a flaky teardown failure in the Windows path suite.
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    it('prints JSON when requested', async () => {
        const logger = { log: vi.fn() };
        const report = await sessionSearchCommand('notify-hook', {
            json: true,
            workingDirectory: repoRoot,
        }, logger);
        expect(report.totalMatches).toBe(1);
        expect(logger.log).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(String(logger.log.mock.calls[0][0]));
        expect(parsed.totalMatches).toBe(1);
        expect(parsed.results[0].sessionId).toBe('session-current');
    });
    it('formats human-readable output', () => {
        const text = formatSessionSearchReport({
            query: 'notify-hook',
            scope: { mode: 'current', caseSensitive: false, workingDirectory: repoRoot },
            searchedFiles: 1,
            totalMatches: 1,
            results: [{
                    sessionId: 'session-current',
                    timestamp: '2026-03-09T10:05:00.000Z',
                    projectPath: repoRoot,
                    sourcePath: '/tmp/session-current.jsonl',
                    sourceType: 'project-transcript',
                    line: 3,
                    role: 'assistant',
                    entryType: 'assistant',
                    excerpt: 'notify-hook regression to stale team leader state',
                }],
        });
        expect(text).toContain('session-current');
        expect(text).toContain('notify-hook');
        expect(text).toContain('/tmp/session-current.jsonl:3');
    });
    it('prints safe friction report JSON when requested', async () => {
        const logger = { log: vi.fn() };
        const report = await sessionFrictionReportCommand({
            json: true,
            workingDirectory: repoRoot,
        }, logger);
        expect(report.privacy.rawContentIncluded).toBe(false);
        expect(logger.log).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(String(logger.log.mock.calls[0][0]));
        expect(parsed.privacy.rawContentIncluded).toBe(false);
        expect(JSON.stringify(parsed)).not.toContain('notify-hook regression');
    });
    it('formats friction report output without raw excerpts', () => {
        const text = formatSessionFrictionReport({
            generatedAt: '2026-03-09T10:05:00.000Z',
            scope: { mode: 'current', caseSensitive: false, workingDirectory: repoRoot },
            privacy: {
                localOnly: true,
                rawContentIncluded: false,
                summary: 'safe metadata only',
            },
            totals: {
                sessions: 1,
                transcriptBytes: 4096,
                transcriptLines: 2,
                toolCalls: 3,
                errorResults: 1,
                criticalSignals: 0,
                warningSignals: 1,
            },
            sessions: [{
                    sessionId: 'session-current',
                    projectPath: repoRoot,
                    sources: ['project-transcript'],
                    lastTimestamp: '2026-03-09T10:05:00.000Z',
                    transcriptBytes: 4096,
                    transcriptLines: 2,
                    userTurns: 1,
                    assistantTurns: 1,
                    toolCalls: 2,
                    toolResults: 1,
                    errorResults: 1,
                    maxLineBytes: 2048,
                    largestMessageBytes: 1024,
                    estimatedContextPercent: 80,
                    contextWindowTokens: 100000,
                    inputTokens: 80000,
                    maxIdleGapMinutes: 10,
                    replayEvents: 0,
                    replayAgentsSpawned: 0,
                    replayAgentsFailed: 0,
                    replayToolCalls: 1,
                    replayHooksFired: 0,
                    frictionScore: 40,
                    signals: [{
                            severity: 'warn',
                            code: 'context-high',
                            message: 'Estimated context usage is high.',
                            evidence: { estimatedContextPercent: 80 },
                        }],
                }],
        });
        expect(text).toContain('Local session friction report');
        expect(text).toContain('session-current');
        expect(text).toContain('context-high');
        expect(text).not.toContain('notify-hook regression');
    });
});
//# sourceMappingURL=session-search.test.js.map