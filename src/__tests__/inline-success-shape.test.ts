/**
 * Tests for inline success response shape contract.
 * Requires full fs + child_process mocking to exercise the success path.
 * Separated from inline-prompt-integration.test.ts because top-level vi.mock('fs')
 * is needed for ESM compatibility (vi.spyOn cannot redefine ESM exports).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { handleAskCodex } from '../mcp/codex-core.js';
import { handleAskGemini } from '../mcp/gemini-core.js';

// Mock CLI detection
vi.mock('../mcp/cli-detection.js', () => ({
  detectCodexCli: vi.fn(() => ({ available: true, path: '/usr/bin/codex', version: '1.0.0', installHint: '' })),
  detectGeminiCli: vi.fn(() => ({ available: true, path: '/usr/bin/gemini', version: '1.0.0', installHint: '' })),
  resetDetectionCache: vi.fn(),
}));

// Mock child_process - spawn returns a mock process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs at module level for ESM compatibility
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    realpathSync: vi.fn((p: any) => String(p)),
    existsSync: vi.fn(() => true),
  };
});

import { spawn } from 'child_process';
import { readFileSync } from 'fs';

function createMockChildProcess(stdoutData: string, exitCode: number = 0): any {
  const proc = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { write: any; end: any };
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  (proc as any).stdout = stdout;
  (proc as any).stderr = stderr;
  (proc as any).stdin = stdin;
  (proc as any).kill = vi.fn();
  process.nextTick(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    process.nextTick(() => {
      proc.emit('close', exitCode);
    });
  });
  return proc;
}

describe('Inline success response shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // readFileSync returns the CLI response when reading the output file
    vi.mocked(readFileSync).mockReturnValue('Mock CLI response output');
  });

  it('Codex inline success returns two content blocks with untrusted wrapper', async () => {
    // Codex outputs JSONL - simulate a successful agent response
    const codexOutput = '{"type":"item.completed","item":{"type":"agent_message","text":"Analysis from Codex"}}\n';
    vi.mocked(spawn).mockReturnValue(createMockChildProcess(codexOutput, 0));

    const result = await handleAskCodex({
      agent_role: 'architect',
      prompt: 'Test inline codex prompt',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    // Block 1: metadata text
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Agent Role');
    expect(result.content[0].text).toContain('Request ID');
    // Block 2: untrusted CLI response wrapper
    expect(result.content[1].type).toBe('text');
    expect(result.content[1].text).toContain('--- UNTRUSTED CLI RESPONSE');
    expect(result.content[1].text).toContain('--- END UNTRUSTED CLI RESPONSE');
  });

  it('Gemini inline success returns two content blocks with untrusted wrapper', async () => {
    // Gemini outputs plain text
    vi.mocked(spawn).mockReturnValue(createMockChildProcess('Design review from Gemini', 0));

    const result = await handleAskGemini({
      agent_role: 'designer',
      prompt: 'Test inline gemini prompt',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    // Block 1: metadata text
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Agent Role');
    expect(result.content[0].text).toContain('Request ID');
    // Block 2: untrusted CLI response wrapper
    expect(result.content[1].type).toBe('text');
    expect(result.content[1].text).toContain('--- UNTRUSTED CLI RESPONSE');
    expect(result.content[1].text).toContain('--- END UNTRUSTED CLI RESPONSE');
  });
});
