import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../callbacks.js', () => ({
  triggerStopCallbacks: vi.fn(async () => undefined),
}));

vi.mock('../../../notifications/index.js', () => ({
  notify: vi.fn(async () => undefined),
}));

vi.mock('../../../tools/python-repl/bridge-manager.js', () => ({
  cleanupBridgeSessions: vi.fn(async () => ({
    requestedSessions: 0,
    foundSessions: 0,
    terminatedSessions: 0,
    errors: [],
  })),
}));

import { processSessionEnd } from '../index.js';
import { cleanupBridgeSessions } from '../../../tools/python-repl/bridge-manager.js';

describe('processSessionEnd python bridge cleanup', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-bridge-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('passes extracted python_repl sessions to cleanupBridgeSessions', async () => {
    const transcriptLines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__t__python_repl', input: { action: 'execute', researchSessionID: 'bridge-A' } },
            { type: 'tool_use', name: 'python_repl', input: { action: 'get_state', researchSessionID: 'bridge-B' } },
          ],
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n'), 'utf-8');

    await processSessionEnd({
      session_id: 'session-123',
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(cleanupBridgeSessions).toHaveBeenCalledTimes(1);
    const calledWith = vi.mocked(cleanupBridgeSessions).mock.calls[0]?.[0] as string[];
    expect(calledWith.sort()).toEqual(['bridge-A', 'bridge-B'].sort());
  });
});

