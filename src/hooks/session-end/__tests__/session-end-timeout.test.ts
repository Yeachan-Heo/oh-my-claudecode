import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── hooks.json timeout validation ──────────────────────────────────────────

describe('SessionEnd hook timeout (issue #1700)', () => {
  it('hooks.json SessionEnd timeout is at least 30 seconds', () => {
    // Read from the repository root hooks.json
    const hooksJsonPath = path.resolve(__dirname, '../../../../hooks/hooks.json');
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));

    const sessionEndEntries = hooksJson.hooks.SessionEnd;
    expect(sessionEndEntries).toBeDefined();
    expect(Array.isArray(sessionEndEntries)).toBe(true);

    for (const entry of sessionEndEntries) {
      for (const hook of entry.hooks) {
        expect(hook.timeout).toBeGreaterThanOrEqual(30);
      }
    }
  });
});

// ── fire-and-forget notification behavior ──────────────────────────────────

vi.mock('../callbacks.js', () => ({
  triggerStopCallbacks: vi.fn(async () => {
    // Simulate a slow notification (2s) — should not block session end
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }),
}));

vi.mock('../../../notifications/index.js', () => ({
  notify: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }),
}));

vi.mock('../../../features/auto-update.js', () => ({
  getOMCConfig: vi.fn(() => ({})),
}));

vi.mock('../../../notifications/config.js', () => ({
  buildConfigFromEnv: vi.fn(() => null),
  getEnabledPlatforms: vi.fn(() => []),
  getNotificationConfig: vi.fn(() => null),
}));

vi.mock('../../../tools/python-repl/bridge-manager.js', () => ({
  cleanupBridgeSessions: vi.fn(async () => ({
    requestedSessions: 0,
    foundSessions: 0,
    terminatedSessions: 0,
    errors: [],
  })),
}));

vi.mock('../../../openclaw/index.js', () => ({
  wakeOpenClaw: vi.fn().mockResolvedValue({ gateway: 'test', success: true }),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

import { processSessionEnd, processSessionEndCleanupWorker, resolveSessionEndCleanupBudgetMs } from '../index.js';
import { triggerStopCallbacks } from '../callbacks.js';
import { cleanupBridgeSessions } from '../../../tools/python-repl/bridge-manager.js';

function decodeSpawnedCleanupPayload(): { sessionId?: string; initialTeamNames?: string[] } {
  const spawnArgs = (childProcessMocks.spawn.mock.calls as unknown as Array<[unknown, string[]]>)[0]?.[1];
  const encodedPayload = spawnArgs?.[spawnArgs.indexOf('--omc-session-end-cleanup-worker') + 1];
  return JSON.parse(Buffer.from(encodedPayload ?? '', 'base64url').toString('utf-8'));
}

describe('SessionEnd fire-and-forget notifications (issue #1700)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-timeout-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
      'utf-8',
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });


  it('processSessionEnd captures session team state in the detached cleanup payload', async () => {
    const sessionId = 'timeout-test-team-payload';
    const cwd = process.cwd();
    const sessionDir = path.join(cwd, '.omc', 'state', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'team-state.json'),
      JSON.stringify({ active: true, session_id: sessionId, team_name: 'payload-team' }),
      'utf-8',
    );

    try {
      await processSessionEnd({
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd,
        permission_mode: 'default',
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      });

      expect(decodeSpawnedCleanupPayload()).toEqual(expect.objectContaining({
        sessionId,
        initialTeamNames: ['payload-team'],
      }));
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('processSessionEnd schedules detached resource cleanup instead of running it in-process', async () => {
    await processSessionEnd({
      session_id: 'timeout-test-python',
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['--omc-session-end-cleanup-worker']),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(cleanupBridgeSessions).not.toHaveBeenCalled();
  });

  it('cleanup worker applies bounded parallel Python REPL cleanup options', async () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'python_repl', input: { researchSessionID: 'py-worker' } }] },
      }),
      'utf-8',
    );

    await processSessionEndCleanupWorker({
      directory: tmpDir,
      sessionId: 'timeout-test-python-worker',
      transcriptPath,
      cleanupBudgetMs: 250,
    });

    expect(cleanupBridgeSessions).toHaveBeenCalledWith(
      ['py-worker'],
      expect.objectContaining({
        gracePeriodMs: 100,
        sigtermGraceMs: 100,
        finalWaitMs: 50,
        parallel: true,
      }),
    );
  });

  it('resolves bounded cleanup budget from env with sane defaults and cap', () => {
    expect(resolveSessionEndCleanupBudgetMs({})).toBe(2000);
    expect(resolveSessionEndCleanupBudgetMs({ OMC_SESSIONEND_CLEANUP_BUDGET_MS: '250' })).toBe(250);
    expect(resolveSessionEndCleanupBudgetMs({ OMC_SESSIONEND_CLEANUP_BUDGET_MS: '25000' })).toBe(10000);
    expect(resolveSessionEndCleanupBudgetMs({ OMC_SESSIONEND_CLEANUP_BUDGET_MS: 'not-a-number' })).toBe(2000);
  });

  it('processSessionEnd completes well before slow notifications finish', async () => {
    const start = Date.now();

    await processSessionEnd({
      session_id: 'timeout-test-1',
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    const elapsed = Date.now() - start;

    // triggerStopCallbacks was called (fire-and-forget)
    expect(triggerStopCallbacks).toHaveBeenCalled();

    // The function should complete in well under the 2s mock delay.
    // Fire-and-forget cleanup should keep synchronous work fast and avoid
    // waiting the full 2s for the mock notification to resolve.
    // In practice this finishes in <100ms; 1500ms is a safe CI threshold.
    expect(elapsed).toBeLessThan(1500);
  });
});
