import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { extractPythonReplSessionIdsFromTranscript } from '../index.js';

describe('session-end python_repl transcript extraction', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-python-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('extracts unique researchSessionID values for python_repl and mcp__t__python_repl tool calls', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'python_repl', input: { action: 'execute', researchSessionID: 'sess-A' } },
            { type: 'tool_use', name: 'mcp__t__python_repl', input: { action: 'execute', researchSessionID: 'sess-B' } },
            { type: 'tool_use', name: 'python_repl', input: { action: 'get_state', researchSessionID: 'sess-A' } },
          ],
        },
      }),
      'not-json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'other', input: {} }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'python_repl', input: { researchSessionID: '  sess-C  ' } }] },
      }),
    ];

    fs.writeFileSync(transcriptPath, lines.join('\n'), 'utf-8');

    const ids = await extractPythonReplSessionIdsFromTranscript(transcriptPath);
    expect(ids.sort()).toEqual(['sess-A', 'sess-B', 'sess-C'].sort());
  });

  it('returns empty array when transcript does not exist', async () => {
    const ids = await extractPythonReplSessionIdsFromTranscript(path.join(tmpDir, 'missing.jsonl'));
    expect(ids).toEqual([]);
  });
});

