/**
 * Tests for ralph-fresh.ts external orchestrator script
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// Mock filesystem and child_process
vi.mock('fs');
vi.mock('child_process');

// Import functions after mocking
import {
  parseArgs,
  runClaude,
  setupSignalHandlers,
  extractCompletionMessage,
  escapeRegex,
  initOrLoadHandoff
} from '../ralph-fresh.js';

describe('parseArgs', () => {
  it('should parse basic prompt argument', () => {
    const mockArgv = ['node', 'ralph-fresh.ts', 'Build a todo app'];
    process.argv = mockArgv;

    const result = parseArgs();

    expect(result.prompt).toBe('Build a todo app');
    expect(result.config.maxIterations).toBe(20); // default
    expect(result.config.maxTurnsPerIteration).toBe(100); // default
  });

  it('should parse --max-iterations flag', () => {
    const mockArgv = ['node', 'ralph-fresh.ts', 'Task', '--max-iterations', '10'];
    process.argv = mockArgv;

    const result = parseArgs();

    expect(result.config.maxIterations).toBe(10);
  });

  it('should parse --max-turns flag', () => {
    const mockArgv = ['node', 'ralph-fresh.ts', 'Task', '--max-turns', '50'];
    process.argv = mockArgv;

    const result = parseArgs();

    expect(result.config.maxTurnsPerIteration).toBe(50);
  });

  it('should parse --verbose flag', () => {
    const mockArgv = ['node', 'ralph-fresh.ts', 'Task', '--verbose'];
    process.argv = mockArgv;

    const result = parseArgs();

    expect(result.config.verbose).toBe(true);
  });

  it('should throw error if no prompt provided', () => {
    const mockArgv = ['node', 'ralph-fresh.ts'];
    process.argv = mockArgv;

    expect(() => parseArgs()).toThrow('No prompt provided');
  });
});

describe('escapeRegex', () => {
  it('should escape regex special characters', () => {
    expect(escapeRegex('TASK_COMPLETE')).toBe('TASK_COMPLETE');
    expect(escapeRegex('test.*')).toBe('test\\.\\*');
    expect(escapeRegex('test[123]')).toBe('test\\[123\\]');
    expect(escapeRegex('test(a|b)')).toBe('test\\(a\\|b\\)');
  });
});

describe('extractCompletionMessage', () => {
  it('should extract completion message from promise tags', () => {
    const output = `
Some output here
<promise>TASK_COMPLETE</promise>
Some completion notes: All stories implemented.
More output
    `;

    const result = extractCompletionMessage(output);

    expect(result).toContain('All stories implemented');
  });

  it('should return text after promise tag even if short', () => {
    const output = `
<promise>TASK_COMPLETE</promise>
No message after
    `;

    const result = extractCompletionMessage(output);

    expect(result).toBe('No message after');
  });

  it('should return empty string if text is too short', () => {
    const output = `
<promise>TASK_COMPLETE</promise>
Short
    `;

    const result = extractCompletionMessage(output);

    expect(result).toBe('');
  });
});

describe('runClaude', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute claude command with correct arguments', async () => {
    const mockConfig = {
      maxIterations: 20,
      maxTurnsPerIteration: 100,
      completionPromise: 'TASK_COMPLETE',
      workingDir: '/test/dir',
      verbose: false,
      retryAttempts: 3,
      retryDelayMs: 5000,
      stuckThreshold: 3
    };

    const mockOutput = JSON.stringify({
      result: 'Task completed',
      session_id: 'abc123'
    });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue(mockOutput);

    const result = await runClaude('Test prompt', mockConfig);

    expect(result.success).toBe(true);
    expect(result.output).toBe('Task completed');
    expect(result.sessionId).toBe('abc123');

    // Verify claude command was called correctly
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('claude'),
      expect.objectContaining({
        cwd: '/test/dir'
      })
    );
  });

  it('should retry on tool_use ids error', async () => {
    const mockConfig = {
      maxIterations: 20,
      maxTurnsPerIteration: 100,
      completionPromise: 'TASK_COMPLETE',
      workingDir: '/test/dir',
      verbose: false,
      retryAttempts: 3,
      retryDelayMs: 100, // short delay for testing
      stuckThreshold: 3
    };

    const error = new Error('tool_use ids must be unique');
    const mockOutput = JSON.stringify({ result: 'Success' });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execSync)
      .mockImplementationOnce(() => { throw error; })
      .mockImplementationOnce(() => { throw error; })
      .mockReturnValueOnce(mockOutput);

    const result = await runClaude('Test prompt', mockConfig);

    expect(result.success).toBe(true);
    expect(execSync).toHaveBeenCalledTimes(3);
  });

  it('should handle max retries exceeded', async () => {
    const mockConfig = {
      maxIterations: 20,
      maxTurnsPerIteration: 100,
      completionPromise: 'TASK_COMPLETE',
      workingDir: '/test/dir',
      verbose: false,
      retryAttempts: 2,
      retryDelayMs: 100,
      stuckThreshold: 3
    };

    const error = new Error('tool_use ids must be unique');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockImplementation(() => { throw error; });

    const result = await runClaude('Test prompt', mockConfig);

    expect(result.success).toBe(false);
    expect(result.output).toContain('tool_use ids must be unique');
    expect(execSync).toHaveBeenCalledTimes(2);
  });
});

describe('setupSignalHandlers', () => {
  it('should register SIGINT and SIGTERM handlers', () => {
    const mockConfig = {
      maxIterations: 20,
      maxTurnsPerIteration: 100,
      completionPromise: 'TASK_COMPLETE',
      workingDir: '/test/dir',
      verbose: false,
      retryAttempts: 3,
      retryDelayMs: 5000,
      stuckThreshold: 3
    };

    const processSpy = vi.spyOn(process, 'on');

    setupSignalHandlers(mockConfig);

    expect(processSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(processSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});

describe('initOrLoadHandoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize new handoff if no state file exists', () => {
    const mockConfig = {
      maxIterations: 20,
      maxTurnsPerIteration: 100,
      completionPromise: 'TASK_COMPLETE',
      workingDir: '/test/dir',
      verbose: false,
      retryAttempts: 3,
      retryDelayMs: 5000,
      stuckThreshold: 3,
      prompt: 'Build app'
    };

    vi.mocked(existsSync).mockReturnValue(false);

    const handoff = initOrLoadHandoff(mockConfig);

    expect(handoff.iteration).toBe(1);
    expect(handoff.max_iterations).toBe(20);
    expect(handoff.original_prompt).toBe('Build app');
    expect(handoff.completed).toBe(false);
  });

  it('should load existing handoff if state file exists', () => {
    const mockConfig = {
      maxIterations: 20,
      maxTurnsPerIteration: 100,
      completionPromise: 'TASK_COMPLETE',
      workingDir: '/test/dir',
      verbose: false,
      retryAttempts: 3,
      retryDelayMs: 5000,
      stuckThreshold: 3,
      prompt: 'Build app'
    };

    const existingHandoff = {
      version: '1.0',
      created_at: '2024-01-01T00:00:00Z',
      iteration: 5,
      max_iterations: 20,
      original_prompt: 'Build app',
      completion_promise: 'TASK_COMPLETE',
      completed: false,
      progress: {
        patterns: ['Test pattern'],
        recentLearnings: []
      },
      git: {
        recentCommits: [],
        branch: 'main',
        hasUncommittedChanges: false
      },
      stuckDetection: {
        lastPrdStatus: [],
        iterationsOnSameStory: 0
      }
    };

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingHandoff));

    const handoff = initOrLoadHandoff(mockConfig);

    expect(handoff.iteration).toBe(5);
    expect(handoff.progress.patterns).toContain('Test pattern');
  });
});
