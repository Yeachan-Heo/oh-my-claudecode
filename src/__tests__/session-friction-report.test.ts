import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateSessionFrictionReport } from '../features/session-friction-report/index.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { encodeProjectPath } from '../utils/encode-project-path.js';

function writeJsonl(filePath: string, entries: Array<Record<string, unknown>>): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}

describe('session friction report', () => {
  const repoRoot = process.cwd();
  let tempRoot: string;
  let claudeDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-session-friction-'));
    claudeDir = join(tempRoot, 'claude');
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.OMC_STATE_DIR = join(tempRoot, 'omc-state');

    const currentProjectDir = join(claudeDir, 'projects', encodeProjectPath(repoRoot));
    writeJsonl(join(currentProjectDir, 'session-current.jsonl'), [
      {
        sessionId: 'session-current',
        cwd: repoRoot,
        type: 'user',
        timestamp: '2026-03-09T10:00:00.000Z',
        message: { role: 'user', content: 'secret prompt text that must not appear in reports' },
        context_window: 100_000,
        input_tokens: 82_000,
      },
      {
        sessionId: 'session-current',
        cwd: repoRoot,
        type: 'assistant',
        timestamp: '2026-03-09T10:10:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } },
            { type: 'tool_result', is_error: true, content: 'raw failing tool output that must not appear' },
          ],
        },
      },
    ]);

    const replayDir = join(getOmcRoot(repoRoot), 'state');
    writeJsonl(join(replayDir, 'agent-replay-session-current.jsonl'), [
      { sessionId: 'session-current', event: 'agent_start', agent: 'agent-1', agent_type: 'executor' },
      { sessionId: 'session-current', event: 'agent_stop', agent: 'agent-1', agent_type: 'executor', success: false },
      { sessionId: 'session-current', event: 'tool_end', agent: 'agent-1', tool: 'Bash', duration_ms: 2500 },
    ]);
  });

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.OMC_STATE_DIR;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports local metadata without raw prompt or tool-result content', async () => {
    const report = await generateSessionFrictionReport({ workingDirectory: repoRoot });

    expect(report.privacy.localOnly).toBe(true);
    expect(report.privacy.rawContentIncluded).toBe(false);
    expect(report.totals.sessions).toBe(1);
    expect(report.sessions[0].sessionId).toBe('session-current');
    expect(report.sessions[0].estimatedContextPercent).toBe(82);
    expect(report.sessions[0].toolCalls).toBe(1);
    expect(report.sessions[0].toolResults).toBe(1);
    expect(report.sessions[0].errorResults).toBe(1);
    expect(report.sessions[0].signals.some((signal) => signal.code === 'context-high')).toBe(true);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('secret prompt text');
    expect(serialized).not.toContain('raw failing tool output');
  });

  it('filters by session id and returns stable JSON-shaped fields', async () => {
    const report = await generateSessionFrictionReport({ workingDirectory: repoRoot, sessionId: 'missing-session' });

    expect(report).toMatchObject({
      privacy: { localOnly: true, rawContentIncluded: false },
      totals: { sessions: 0, transcriptBytes: 0, transcriptLines: 0 },
      sessions: [],
    });
  });

  it('includes OMC replay artifacts for all-project reports', async () => {
    const report = await generateSessionFrictionReport({ workingDirectory: repoRoot, project: 'all' });

    expect(report.sessions.some((session) => session.sessionId === 'session-current')).toBe(true);
    const session = report.sessions.find((candidate) => candidate.sessionId === 'session-current');
    expect(session?.sources).toContain('omc-session-replay');
    expect(session?.replayAgentsFailed).toBe(1);
  });

  it('keeps project-local OMC replay artifacts when entries have no cwd', async () => {
    const report = await generateSessionFrictionReport({ workingDirectory: repoRoot, project: 'oh-my-claudecode' });

    const session = report.sessions.find((candidate) => candidate.sessionId === 'session-current');
    expect(session?.sources).toContain('omc-session-replay');
    expect(session?.replayToolCalls).toBe(1);
  });
});
