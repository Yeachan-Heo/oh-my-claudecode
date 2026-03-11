import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSinceSpec, searchSessionHistory, } from '../features/session-history-search/index.js';
function encodeProjectPath(projectPath) {
    return projectPath.replace(/[\\/]/g, '-');
}
function writeTranscript(filePath, entries) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}
describe('session history search', () => {
    const repoRoot = process.cwd();
    let tempRoot;
    let claudeDir;
    let otherProject;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-session-search-'));
        claudeDir = join(tempRoot, 'claude');
        otherProject = join(tempRoot, 'other-project');
        process.env.CLAUDE_CONFIG_DIR = claudeDir;
        process.env.OMC_STATE_DIR = join(tempRoot, 'omc-state');
        const currentProjectDir = join(claudeDir, 'projects', encodeProjectPath(repoRoot));
        const otherProjectDir = join(claudeDir, 'projects', encodeProjectPath(otherProject));
        writeTranscript(join(currentProjectDir, 'session-current.jsonl'), [
            {
                sessionId: 'session-current',
                cwd: repoRoot,
                type: 'user',
                timestamp: '2026-03-09T10:00:00.000Z',
                message: { role: 'user', content: 'Search prior sessions for notify-hook failures and stale team leader notes.' },
            },
            {
                sessionId: 'session-current',
                cwd: repoRoot,
                type: 'assistant',
                timestamp: '2026-03-09T10:05:00.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'We traced the notify-hook regression to stale team leader state in a prior run.' }] },
            },
        ]);
        writeTranscript(join(currentProjectDir, 'session-older.jsonl'), [
            {
                sessionId: 'session-older',
                cwd: repoRoot,
                type: 'assistant',
                timestamp: '2026-02-20T08:00:00.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Old provider routing discussion for archival context.' }] },
            },
        ]);
        writeTranscript(join(otherProjectDir, 'session-other.jsonl'), [
            {
                sessionId: 'session-other',
                cwd: otherProject,
                type: 'assistant',
                timestamp: '2026-03-08T12:00:00.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'notify-hook appears here too, but only in another project.' }] },
            },
        ]);
    });
    afterEach(() => {
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.OMC_STATE_DIR;
        rmSync(tempRoot, { recursive: true, force: true });
    });
    it('searches the current project by default and returns structured snippets', async () => {
        const report = await searchSessionHistory({
            query: 'notify-hook stale team leader',
            workingDirectory: repoRoot,
        });
        expect(report.scope.mode).toBe('current');
        expect(report.totalMatches).toBe(2);
        expect(report.results).toHaveLength(2);
        expect(report.results.every((result) => result.projectPath === repoRoot)).toBe(true);
        expect(report.results.some((result) => result.sessionId === 'session-current')).toBe(true);
        expect(report.results[0].excerpt.toLowerCase()).toContain('notify-hook');
        expect(report.results[0].sourcePath).toContain('session-current.jsonl');
    });
    it('supports since and session filters', async () => {
        const recentOnly = await searchSessionHistory({
            query: 'provider routing',
            since: '7d',
            project: 'all',
            workingDirectory: repoRoot,
        });
        expect(recentOnly.totalMatches).toBe(0);
        const olderSession = await searchSessionHistory({
            query: 'provider routing',
            sessionId: 'session-older',
            project: 'all',
            workingDirectory: repoRoot,
        });
        expect(olderSession.totalMatches).toBe(1);
        expect(olderSession.results[0].sessionId).toBe('session-older');
    });
    it('can search across all projects and apply result limits', async () => {
        const report = await searchSessionHistory({
            query: 'notify-hook',
            project: 'all',
            limit: 1,
            workingDirectory: repoRoot,
        });
        expect(report.scope.mode).toBe('all');
        expect(report.totalMatches).toBe(3);
        expect(report.results).toHaveLength(1);
        expect(report.results[0].sessionId).toBe('session-current');
    });
    it('parses relative and absolute since values', () => {
        const relative = parseSinceSpec('7d');
        expect(relative).toBeTypeOf('number');
        expect(parseSinceSpec('2026-03-01')).toBe(Date.parse('2026-03-01'));
        expect(parseSinceSpec('')).toBeUndefined();
    });
});
//# sourceMappingURL=session-history-search.test.js.map