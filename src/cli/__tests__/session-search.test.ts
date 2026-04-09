import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  formatSessionSearchReport,
  sessionSearchCommand,
} from '../commands/session-search.js';

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[/\\.]/g, '-');
}

function writeTranscript(filePath: string, entries: Array<Record<string, unknown>>): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}

describe('session search cli command', () => {
  const repoRoot = process.cwd();
  let tempRoot: string;
  let claudeDir: string;

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
    rmSync(tempRoot, { recursive: true, force: true });
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
});
