/**
 * Tests for src/cli/tmux-utils.ts
 *
 * Covers:
 * - wrapWithLoginShell (issue #1153 — shell RC not loaded in tmux)
 * - quoteShellArg
 * - sanitizeTmuxToken
 * - createHudWatchPane login shell wrapping
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

import {
  resolveLaunchPolicy,
  tmuxExec,
  tmuxSpawn,
  wrapWithLoginShell,
  quoteShellArg,
  sanitizeTmuxToken,
} from '../tmux-utils.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolveLaunchPolicy
// ---------------------------------------------------------------------------
describe('resolveLaunchPolicy', () => {
  it('forces direct mode for --print even when tmux is available', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('tmux 3.4'));

    expect(resolveLaunchPolicy({}, ['--print'])).toBe('direct');
  });

  it('forces direct mode for -p even when tmux is available', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('tmux 3.4'));

    expect(resolveLaunchPolicy({}, ['-p'])).toBe('direct');
  });

  it('does not treat --print-system-prompt as print mode', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('tmux 3.4'));

    expect(resolveLaunchPolicy({ TMUX: '1' }, ['--print-system-prompt'])).toBe('inside-tmux');
  });

  it('returns "direct" when CMUX_SURFACE_ID is set (cmux terminal)', () => {
    mockedExecFileSync.mockReturnValue('tmux 3.6a' as any);
    expect(resolveLaunchPolicy({ CMUX_SURFACE_ID: 'C0D4B400-6C27-4957-BD01-32735B2251CD' })).toBe('direct');
  });

  it('keeps inside-tmux authoritative even when tmux availability probing fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('tmux not found');
    });
    expect(resolveLaunchPolicy({ TMUX: '/tmp/tmux-501/default,1234,0' })).toBe('inside-tmux');
  });

  it('prefers inside-tmux over cmux when both TMUX and CMUX_SURFACE_ID are set', () => {
    mockedExecFileSync.mockReturnValue('tmux 3.6a' as any);
    expect(resolveLaunchPolicy({
      TMUX: '/tmp/tmux-501/default,1234,0',
      CMUX_SURFACE_ID: 'some-id',
    })).toBe('inside-tmux');
  });

  it('returns "outside-tmux" when tmux is available but no TMUX or CMUX env', () => {
    mockedExecFileSync.mockReturnValue('tmux 3.6a' as any);
    expect(resolveLaunchPolicy({})).toBe('outside-tmux');
  });

  it('returns "direct" when tmux is not available', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('tmux not found');
    });
    expect(resolveLaunchPolicy({})).toBe('direct');
  });

  it('detects tmux.cmd via COMSPEC on win32', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    mockedSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      } as ReturnType<typeof spawnSync>);

    expect(resolveLaunchPolicy({})).toBe('outside-tmux');
    expect(mockedSpawnSync).toHaveBeenNthCalledWith(1, 'where', ['tmux'], { timeout: 5000, encoding: 'utf8' });
    expect(mockedSpawnSync).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" -V'],
      { timeout: 5000 }
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});

describe('tmux command execution parity on Windows', () => {
  it('routes tmuxExec through COMSPEC when where resolves tmux.cmd', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    mockedSpawnSync.mockClear();
    mockedExecFileSync.mockClear();
    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExecFileSync.mockReturnValue('ok' as any);

    tmuxExec(['list-sessions']);

    expect(mockedExecFileSync).toHaveBeenLastCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" list-sessions'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('routes tmuxSpawn through COMSPEC when where resolves tmux.cmd', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    mockedSpawnSync.mockClear();
    mockedSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      } as ReturnType<typeof spawnSync>);

    tmuxSpawn(['list-panes']);

    expect(mockedSpawnSync).toHaveBeenLastCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" list-panes'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('quotes parenthesized tmux arguments when invoking through COMSPEC', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');

    mockedSpawnSync.mockClear();
    mockedExecFileSync.mockClear();
    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: 'C:\\Program Files\\psmux\\tmux.cmd\r\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    mockedExecFileSync.mockReturnValue('ok' as any);

    tmuxExec(['send-keys', 'foo(bar)']);

    expect(mockedExecFileSync).toHaveBeenLastCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Program Files\\psmux\\tmux.cmd" send-keys "foo(bar)"'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
});

// ---------------------------------------------------------------------------
// wrapWithLoginShell
// ---------------------------------------------------------------------------
describe('wrapWithLoginShell', () => {
  it('wraps command with login shell using $SHELL', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    const result = wrapWithLoginShell('claude --print');
    expect(result).toContain('/bin/zsh');
    expect(result).toContain('-lc');
    expect(result).toContain('claude --print');
    expect(result).toMatch(/^exec /);
  });

  it('defaults to /bin/bash when $SHELL is not set', () => {
    vi.stubEnv('SHELL', '');
    const result = wrapWithLoginShell('codex');
    expect(result).toContain('/bin/bash');
    expect(result).toContain('-lc');
  });

  it('properly quotes the inner command containing single quotes', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    const result = wrapWithLoginShell("perl -e 'print 1'");
    expect(result).toContain('-lc');
    expect(result).toContain('perl');
    expect(result).toContain('print 1');
  });

  it('uses exec to replace the outer shell process', () => {
    vi.stubEnv('SHELL', '/bin/bash');
    const result = wrapWithLoginShell('my-command');
    expect(result).toMatch(/^exec /);
  });

  it('works with complex multi-statement commands', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    const cmd = 'sleep 0.3; echo hello; claude --dangerously-skip-permissions';
    const result = wrapWithLoginShell(cmd);
    expect(result).toContain('/bin/zsh');
    expect(result).toContain('-lc');
    expect(result).toContain('sleep 0.3');
    expect(result).toContain('claude');
  });

  it('handles shells with unusual paths', () => {
    vi.stubEnv('SHELL', '/usr/local/bin/fish');
    const result = wrapWithLoginShell('codex');
    expect(result).toContain('/usr/local/bin/fish');
    expect(result).toContain('-lc');
  });

  it('sources ~/.zshrc for zsh shells', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/testuser');
    const result = wrapWithLoginShell('claude');
    expect(result).toContain('.zshrc');
    expect(result).toContain('/home/testuser/.zshrc');
  });

  it('sources ~/.bashrc for bash shells', () => {
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('HOME', '/home/testuser');
    const result = wrapWithLoginShell('claude');
    expect(result).toContain('.bashrc');
    expect(result).toContain('/home/testuser/.bashrc');
  });

  it('sources ~/.fishrc for fish shells', () => {
    vi.stubEnv('SHELL', '/usr/local/bin/fish');
    vi.stubEnv('HOME', '/home/testuser');
    const result = wrapWithLoginShell('codex');
    expect(result).toContain('.fishrc');
    expect(result).toContain('/home/testuser/.fishrc');
  });

  it('skips rc sourcing when HOME is not set', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '');
    const result = wrapWithLoginShell('claude');
    expect(result).not.toContain('.zshrc');
    expect(result).toContain('claude');
  });

  it('uses conditional test before sourcing rc file', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('HOME', '/home/testuser');
    const result = wrapWithLoginShell('claude');
    expect(result).toContain('[ -f');
    expect(result).toContain('] && .');
  });
});

// ---------------------------------------------------------------------------
// quoteShellArg
// ---------------------------------------------------------------------------
describe('quoteShellArg', () => {
  it('wraps value in single quotes', () => {
    expect(quoteShellArg('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    const result = quoteShellArg("it's");
    expect(result).toContain("'\"'\"'");
  });
});

// ---------------------------------------------------------------------------
// sanitizeTmuxToken
// ---------------------------------------------------------------------------
describe('sanitizeTmuxToken', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(sanitizeTmuxToken('My_Project.Name')).toBe('my-project-name');
    expect(sanitizeTmuxToken('MyProject')).toBe('myproject');
    expect(sanitizeTmuxToken('my project!')).toBe('my-project');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeTmuxToken('--hello--')).toBe('hello');
  });

  it('returns "unknown" for empty result', () => {
    expect(sanitizeTmuxToken('...')).toBe('unknown');
    expect(sanitizeTmuxToken('!!!')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// createHudWatchPane — login shell wrapping
// ---------------------------------------------------------------------------
describe('createHudWatchPane login shell wrapping', () => {
  it('wraps hudCmd with wrapWithLoginShell in source code', () => {
    // Verify the source uses wrapWithLoginShell for the HUD command
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'tmux-utils.ts'),
      'utf-8'
    );
    expect(source).toContain('wrapWithLoginShell(hudCmd)');
  });
});
