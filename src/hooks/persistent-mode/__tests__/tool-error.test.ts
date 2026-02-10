/**
 * Unit tests for tool error detection and retry guidance
 * Tests the functions that read tool error state and generate retry messages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readLastToolError,
  clearToolErrorState,
  getToolErrorRetryGuidance,
  type ToolErrorState
} from '../index.js';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Functions are now imported from ../index.js

describe('readLastToolError', () => {
  const testDir = '/test';
  const errorPath = join(testDir, '.omc', 'state', 'last-tool-error.json');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid ToolErrorState when file exists with recent timestamp', () => {
    const recentError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Command not found: nonexistent',
      timestamp: new Date().toISOString(),
      retry_count: 1,
    };

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(recentError)
    );

    const result = readLastToolError(testDir);

    expect(result).toEqual(recentError);
    expect(existsSync).toHaveBeenCalledWith(errorPath);
    expect(readFileSync).toHaveBeenCalledWith(errorPath, 'utf-8');
  });

  it('returns null when file does not exist', () => {
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = readLastToolError(testDir);

    expect(result).toBeNull();
    expect(existsSync).toHaveBeenCalledWith(errorPath);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('returns null when error is stale (>60 seconds old)', () => {
    const staleTimestamp = new Date(Date.now() - 65000).toISOString(); // 65 seconds ago
    const staleError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Old error',
      timestamp: staleTimestamp,
      retry_count: 1,
    };

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(staleError)
    );

    const result = readLastToolError(testDir);

    expect(result).toBeNull();
  });

  it('returns null when file contains malformed JSON', () => {
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      'invalid json{{'
    );

    const result = readLastToolError(testDir);

    expect(result).toBeNull();
  });

  it('handles missing timestamp field gracefully', () => {
    const errorWithoutTimestamp = {
      tool_name: 'Bash',
      error: 'Some error',
      retry_count: 1,
      // timestamp is missing
    };

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(errorWithoutTimestamp)
    );

    const result = readLastToolError(testDir);

    expect(result).toBeNull();
  });

  it('handles readFileSync throwing error', () => {
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = readLastToolError(testDir);

    expect(result).toBeNull();
  });
});

describe('clearToolErrorState', () => {
  const testDir = '/test';
  const errorPath = join(testDir, '.omc', 'state', 'last-tool-error.json');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes state file when it exists', () => {
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (unlinkSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    clearToolErrorState(testDir);

    expect(existsSync).toHaveBeenCalledWith(errorPath);
    expect(unlinkSync).toHaveBeenCalledWith(errorPath);
  });

  it('does not throw when file does not exist', () => {
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    expect(() => clearToolErrorState(testDir)).not.toThrow();
    expect(existsSync).toHaveBeenCalledWith(errorPath);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('handles permission errors gracefully', () => {
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (unlinkSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => clearToolErrorState(testDir)).not.toThrow();
    expect(unlinkSync).toHaveBeenCalledWith(errorPath);
  });

  it('handles unlinkSync throwing ENOENT error', () => {
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (unlinkSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    expect(() => clearToolErrorState(testDir)).not.toThrow();
  });
});

describe('getToolErrorRetryGuidance', () => {
  it('returns empty string for null input', () => {
    const result = getToolErrorRetryGuidance(null);

    expect(result).toBe('');
  });

  it('returns retry message with error context for normal errors (retry_count < 5)', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'cd: no such file or directory: /nonexistent',
      timestamp: new Date().toISOString(),
      retry_count: 1,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('[TOOL ERROR - RETRY REQUIRED]');
    expect(result).toContain('"Bash" operation failed');
    expect(result).toContain('cd: no such file or directory: /nonexistent');
    expect(result).toContain('REQUIRED ACTIONS:');
    expect(result).toContain('RETRY the operation with corrected parameters');
    expect(result).not.toContain('ALTERNATIVE APPROACH NEEDED');
  });

  it('returns alternative approach message when retry_count >= 5', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Command keeps failing',
      timestamp: new Date().toISOString(),
      retry_count: 5,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('[TOOL ERROR - ALTERNATIVE APPROACH NEEDED]');
    expect(result).toContain('"Bash" operation has failed 5 times');
    expect(result).toContain('STOP RETRYING THE SAME APPROACH');
    expect(result).toContain('Try a completely different command or approach');
    expect(result).toContain('If stuck, ask the user for guidance');
    expect(result).not.toContain('RETRY the operation');
  });

  it('includes tool name and error in message', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Edit',
      error: 'File not found: /path/to/file.ts',
      timestamp: new Date().toISOString(),
      retry_count: 2,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('"Edit" operation failed');
    expect(result).toContain('File not found: /path/to/file.ts');
  });

  it('shows retry message after 3+ failures', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Permission denied',
      timestamp: new Date().toISOString(),
      retry_count: 3,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('[TOOL ERROR - RETRY REQUIRED]');
    expect(result).toContain('Permission denied');
  });

  it('shows retry message for less than 3 failures', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Some error',
      timestamp: new Date().toISOString(),
      retry_count: 2,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('[TOOL ERROR - RETRY REQUIRED]');
    expect(result).toContain('Some error');
  });

  it('handles missing tool_name gracefully', () => {
    const toolError: ToolErrorState = {
      tool_name: '',
      error: 'Some error',
      timestamp: new Date().toISOString(),
      retry_count: 1,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('"unknown" operation failed');
  });

  it('handles missing error field gracefully', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: '',
      timestamp: new Date().toISOString(),
      retry_count: 1,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('Error: Unknown error');
  });
});

describe('Integration: Continuation message with tool error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continuation message includes error context when tool error present', () => {
    const testDir = '/test';
    const errorPath = join(testDir, '.omc', 'state', 'last-tool-error.json');
    const recentError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Command not found: invalid-command',
      timestamp: new Date().toISOString(),
      retry_count: 1,
    };

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(recentError)
    );

    // Simulate continuation message construction
    const toolError = readLastToolError(testDir);
    const errorGuidance = getToolErrorRetryGuidance(toolError);
    const baseMessage = '[ULTRAWORK #5/50] Mode active. Continue working.';
    const fullMessage = errorGuidance ? errorGuidance + baseMessage : baseMessage;

    expect(fullMessage).toContain('[TOOL ERROR - RETRY REQUIRED]');
    expect(fullMessage).toContain('Command not found: invalid-command');
    expect(fullMessage).toContain('[ULTRAWORK #5/50]');
  });

  it('continuation message is normal when no tool error', () => {
    const testDir = '/test';

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Simulate continuation message construction
    const toolError = readLastToolError(testDir);
    const errorGuidance = getToolErrorRetryGuidance(toolError);
    const baseMessage = '[ULTRAWORK #5/50] Mode active. Continue working.';
    const fullMessage = errorGuidance ? errorGuidance + baseMessage : baseMessage;

    expect(fullMessage).toBe('[ULTRAWORK #5/50] Mode active. Continue working.');
    expect(fullMessage).not.toContain('[TOOL ERROR');
  });

  it('error state is cleared after reading', () => {
    const testDir = '/test';
    const errorPath = join(testDir, '.omc', 'state', 'last-tool-error.json');
    const recentError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Some error',
      timestamp: new Date().toISOString(),
      retry_count: 1,
    };

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(recentError)
    );
    (unlinkSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    // Read error and generate message
    const toolError = readLastToolError(testDir);
    expect(toolError).not.toBeNull();

    // Clear after reading
    if (toolError) {
      clearToolErrorState(testDir);
    }

    expect(unlinkSync).toHaveBeenCalledWith(errorPath);
  });
});

describe('Edge cases and error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles error state with retry_count at boundary (exactly 5)', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Persistent failure',
      timestamp: new Date().toISOString(),
      retry_count: 5,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('[TOOL ERROR - ALTERNATIVE APPROACH NEEDED]');
    expect(result).toContain('has failed 5 times');
  });

  it('handles error state with retry_count at boundary (exactly 3)', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Some error',
      timestamp: new Date().toISOString(),
      retry_count: 3,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('[TOOL ERROR - RETRY REQUIRED]');
    expect(result).toContain('Some error');
  });

  it('handles error state with very high retry_count', () => {
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Completely stuck',
      timestamp: new Date().toISOString(),
      retry_count: 100,
    };

    const result = getToolErrorRetryGuidance(toolError);

    expect(result).toContain('[TOOL ERROR - ALTERNATIVE APPROACH NEEDED]');
    expect(result).toContain('has failed 100 times');
  });

  it('handles error state at exact 60 second boundary (not stale)', () => {
    const exactlyAtBoundary = new Date(Date.now() - 59999).toISOString(); // 59.999 seconds ago
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Error at boundary',
      timestamp: exactlyAtBoundary,
      retry_count: 1,
    };

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(toolError)
    );

    const result = readLastToolError('/test');

    expect(result).not.toBeNull();
    expect(result?.error).toBe('Error at boundary');
  });

  it('handles error state just past 60 second boundary (stale)', () => {
    const justPastBoundary = new Date(Date.now() - 60001).toISOString(); // 60.001 seconds ago
    const toolError: ToolErrorState = {
      tool_name: 'Bash',
      error: 'Stale error',
      timestamp: justPastBoundary,
      retry_count: 1,
    };

    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify(toolError)
    );

    const result = readLastToolError('/test');

    expect(result).toBeNull();
  });
});
