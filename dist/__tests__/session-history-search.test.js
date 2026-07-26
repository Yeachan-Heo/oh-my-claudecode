import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';
import { __testingIsWithinProject, encodeProjectPath, parseSinceSpec, searchSessionHistory, } from '../features/session-history-search/index.js';
function writeTranscript(filePath, entries) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}
function normalizePathForAssert(path) {
    return path.replace(/\\/g, '/');
}
describe('session history search', () => {
    const repoRoot = process.cwd();
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    let tempRoot;
    let claudeDir;
    let otherProject;
    let tildeClaudeDir;
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'omc-session-search-'));
        claudeDir = join(tempRoot, 'claude');
        otherProject = join(tempRoot, 'other-project');
        tildeClaudeDir = join(homedir(), `.omc-session-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        if (originalConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        }
        delete process.env.OMC_STATE_DIR;
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        rmSync(tildeClaudeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    it('searches transcripts stored under the literal subdirectory cwd project dir', async () => {
        const subdirCwd = join(repoRoot, 'src');
        const subdirProjectDir = join(claudeDir, 'projects', encodeProjectPath(subdirCwd));
        writeTranscript(join(subdirProjectDir, 'session-subdir.jsonl'), [
            {
                sessionId: 'session-subdir',
                cwd: subdirCwd,
                type: 'assistant',
                timestamp: '2026-03-11T10:00:00.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'subdirectory cwd transcript sentinel' }] },
            },
        ]);
        const report = await searchSessionHistory({
            query: 'subdirectory cwd transcript sentinel',
            workingDirectory: subdirCwd,
        });
        expect(report.scope.mode).toBe('current');
        expect(report.scope.workingDirectory).toBeDefined();
        const workingDirectory = report.scope.workingDirectory;
        expect(normalizePathForAssert(workingDirectory)).toBe(normalizePathForAssert(repoRoot));
        expect(report.totalMatches).toBe(1);
        expect(report.results[0]).toBeDefined();
        const result = report.results[0];
        expect(result.sessionId).toBe('session-subdir');
        expect(result.projectPath).toBeDefined();
        const resultProjectPath = result.projectPath;
        expect(normalizePathForAssert(resultProjectPath)).toBe(normalizePathForAssert(subdirCwd));
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
    it('uses a ~-prefixed CLAUDE_CONFIG_DIR for transcript discovery', async () => {
        process.env.CLAUDE_CONFIG_DIR = `~/${basename(tildeClaudeDir)}`;
        const tildeProjectDir = join(tildeClaudeDir, 'projects', encodeProjectPath(repoRoot));
        writeTranscript(join(tildeProjectDir, 'session-tilde.jsonl'), [
            {
                sessionId: 'session-tilde',
                cwd: repoRoot,
                type: 'assistant',
                timestamp: '2026-03-10T10:00:00.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: 'tilde config dir search hit' }] },
            },
        ]);
        const report = await searchSessionHistory({
            query: 'tilde config dir search hit',
            workingDirectory: repoRoot,
        });
        expect(report.totalMatches).toBe(1);
        expect(report.results[0].sessionId).toBe('session-tilde');
    });
    it('encodes a Windows drive path the same way Claude Code names its project dir', () => {
        // Regression: the drive colon must be replaced with "-" so the encoded directory
        // matches Claude Code's actual project dir (e.g. ~/.claude/projects/C--Users-me-proj).
        // Before the fix this returned "C:-Users-me-proj", which never matched on Windows and
        // made current-scope search find zero project transcripts. Platform-independent: this
        // asserts the encoding of a literal Windows-style string regardless of host OS.
        expect(encodeProjectPath('C:\\Users\\me\\proj')).toBe('C--Users-me-proj');
        // POSIX paths are unaffected (no colon to replace).
        expect(encodeProjectPath('/home/me/proj')).toBe('-home-me-proj');
    });
    it('keeps Windows-style subdirectory paths within their project root', () => {
        expect(__testingIsWithinProject('C:\\Users\\me\\repo\\packages\\api', ['C:\\Users\\me\\repo'])).toBe(true);
        expect(__testingIsWithinProject('C:\\Users\\me\\repo-other', ['C:\\Users\\me\\repo'])).toBe(false);
    });
    it('parses relative and absolute since values', () => {
        const relative = parseSinceSpec('7d');
        expect(relative).toBeTypeOf('number');
        expect(parseSinceSpec('2026-03-01')).toBe(Date.parse('2026-03-01'));
        expect(parseSinceSpec('')).toBeUndefined();
    });
});
//# sourceMappingURL=session-history-search.test.js.map