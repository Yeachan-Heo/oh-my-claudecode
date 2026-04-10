/**
 * Tests for src/cli/launch.ts
 *
 * Covers:
 * - Exit code propagation (runClaude direct / inside-tmux)
 * - No OMC HUD pane spawning in tmux launch paths
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock('../tmux-utils.js', () => ({
  resolveLaunchPolicy: vi.fn(),
  buildTmuxSessionName: vi.fn(() => 'test-session'),
  buildTmuxShellCommand: vi.fn((cmd: string, args: string[]) => `${cmd} ${args.join(' ')}`),
  wrapWithLoginShell: vi.fn((cmd: string) => cmd),
  quoteShellArg: vi.fn((s: string) => s),
  isClaudeAvailable: vi.fn(() => true),
  tmuxExec: vi.fn(),
}));

import { runClaude, launchCommand, extractNotifyFlag, extractOpenClawFlag, extractTelegramFlag, extractDiscordFlag, extractSlackFlag, extractWebhookFlag, normalizeClaudeLaunchArgs, isPrintMode, prepareOmcLaunchConfigDir, buildEnvExportPrefix, TMUX_ENV_FORWARD } from '../launch.js';
import {
  resolveLaunchPolicy,
  buildTmuxShellCommand,
  wrapWithLoginShell,
  tmuxExec,
} from '../tmux-utils.js';

// ---------------------------------------------------------------------------
// extractNotifyFlag
// ---------------------------------------------------------------------------
describe('extractNotifyFlag', () => {
  it('returns notifyEnabled=true with no --notify flag', () => {
    const result = extractNotifyFlag(['--madmax']);
    expect(result.notifyEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--madmax']);
  });

  it('disables notifications with --notify false', () => {
    const result = extractNotifyFlag(['--notify', 'false']);
    expect(result.notifyEnabled).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('disables notifications with --notify=false', () => {
    const result = extractNotifyFlag(['--notify=false']);
    expect(result.notifyEnabled).toBe(false);
  });

  it('disables notifications with --notify 0', () => {
    const result = extractNotifyFlag(['--notify', '0']);
    expect(result.notifyEnabled).toBe(false);
  });

  it('keeps notifications enabled with --notify true', () => {
    const result = extractNotifyFlag(['--notify', 'true']);
    expect(result.notifyEnabled).toBe(true);
  });

  it('treats bare --notify as enabled and strips it', () => {
    const result = extractNotifyFlag(['--notify', '--print']);
    expect(result.notifyEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--print']);
  });

  it('does not consume the next flag after bare --notify', () => {
    const result = extractNotifyFlag(['--notify', '--discord']);
    expect(result.notifyEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--discord']);
  });

  it('strips --notify from remainingArgs', () => {
    const result = extractNotifyFlag(['--madmax', '--notify', 'false', '--print']);
    expect(result.remainingArgs).toEqual(['--madmax', '--print']);
  });
});

// ---------------------------------------------------------------------------
// normalizeClaudeLaunchArgs
// ---------------------------------------------------------------------------
describe('normalizeClaudeLaunchArgs', () => {
  it('maps --madmax to --dangerously-skip-permissions', () => {
    expect(normalizeClaudeLaunchArgs(['--madmax'])).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('maps --yolo to --dangerously-skip-permissions', () => {
    expect(normalizeClaudeLaunchArgs(['--yolo'])).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('deduplicates --dangerously-skip-permissions', () => {
    const result = normalizeClaudeLaunchArgs([
      '--madmax',
      '--dangerously-skip-permissions',
    ]);
    expect(
      result.filter((a) => a === '--dangerously-skip-permissions'),
    ).toHaveLength(1);
  });

  it('passes unknown flags through unchanged', () => {
    expect(normalizeClaudeLaunchArgs(['--print', '--verbose'])).toEqual([
      '--print',
      '--verbose',
    ]);
  });
});

// ---------------------------------------------------------------------------
// runClaude — exit code propagation
// ---------------------------------------------------------------------------
describe('runClaude — exit code propagation', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  describe('direct policy', () => {
    beforeEach(() => {
      (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('direct');
    });

    it('bypasses tmux for --print mode', () => {
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));

      runClaude('/tmp', ['--print'], 'sid');

      // isPrintMode short-circuits before resolveLaunchPolicy is called
      expect(resolveLaunchPolicy).not.toHaveBeenCalled();
      expect(vi.mocked(execFileSync).mock.calls.find(([cmd]) => cmd === 'tmux')).toBeUndefined();
      expect(vi.mocked(execFileSync).mock.calls.find(([cmd]) => cmd === 'claude')?.[1]).toEqual(['--print']);
    });

    it('propagates Claude non-zero exit code', () => {
      const err = Object.assign(new Error('Command failed'), { status: 2 });
      (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 1 when status is null', () => {
      const err = Object.assign(new Error('Command failed'), { status: null });
      (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 on ENOENT', () => {
      const err = Object.assign(new Error('Not found'), { code: 'ENOENT' });
      (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('does not call process.exit on success', () => {
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  describe('inside-tmux policy', () => {
    beforeEach(() => {
      (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('inside-tmux');
      process.env.TMUX_PANE = '%0';
    });

    afterEach(() => {
      delete process.env.TMUX_PANE;
    });

    it('propagates Claude non-zero exit code', () => {
      const err = Object.assign(new Error('Command failed'), { status: 3 });
      (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it('exits with code 1 when status is null', () => {
      const err = Object.assign(new Error('Command failed'), { status: null });
      (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 on ENOENT', () => {
      const err = Object.assign(new Error('Not found'), { code: 'ENOENT' });
      (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('does not call process.exit on success', () => {
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));

      runClaude('/tmp', [], 'sid');

      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// runClaude — OMC HUD pane spawning disabled
// ---------------------------------------------------------------------------
describe('runClaude OMC HUD behavior', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
  });

  it('does not build an omc hud --watch command inside tmux', () => {
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('inside-tmux');

    runClaude('/tmp/cwd', [], 'test-session');

    const calls = vi.mocked(buildTmuxShellCommand).mock.calls;
    const omcHudCall = calls.find(
      ([cmd, args]) => cmd === 'node' && Array.isArray(args) && args.includes('hud'),
    );
    expect(omcHudCall).toBeUndefined();
  });

  it('does not add split-window HUD pane args when launching outside tmux', () => {
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('outside-tmux');

    runClaude('/tmp/cwd', [], 'test-session');

    const tmuxCalls = vi.mocked(tmuxExec).mock.calls;
    expect(tmuxCalls.length).toBeGreaterThan(0);
    expect(tmuxCalls.every(([args]) => !args.includes('split-window'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runClaude — outside-tmux mouse scrolling (issue #890 regression guard)
// ---------------------------------------------------------------------------
describe('runClaude outside-tmux — mouse scrolling (issue #890)', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('outside-tmux');
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('uses session-targeted mouse option instead of global (-t sessionName, not -g)', () => {
    runClaude('/tmp', [], 'sid');

    const tmuxCalls = vi.mocked(tmuxExec).mock.calls;
    const tmuxCall = tmuxCalls.find(([args]) => args[0] === 'set-option');
    expect(tmuxCall).toBeDefined();

    const tmuxArgs = tmuxCall![0];
    expect(tmuxArgs).toContain('-t');
    const tIdx = tmuxArgs.indexOf('-t');
    expect(tmuxArgs[tIdx + 1]).toBe('test-session');
    expect(tmuxArgs).toContain('mouse');
    expect(tmuxArgs).toContain('on');
    expect(tmuxArgs).not.toContain('-g');
  });

  it('does not set terminal-overrides in tmux args', () => {
    runClaude('/tmp', [], 'sid');

    const tmuxCalls = vi.mocked(tmuxExec).mock.calls;
    const tmuxCall = tmuxCalls.find(([args]) => args[0] === 'new-session');
    expect(tmuxCall).toBeDefined();
    const tmuxArgs = tmuxCall![0];

    expect(tmuxArgs).not.toContain('terminal-overrides');
    expect(tmuxArgs).not.toContain('*:smcup@:rmcup@');
  });

  it('places mouse mode setup before attach-session', () => {
    runClaude('/tmp', [], 'sid');

    const tmuxCalls = vi.mocked(tmuxExec).mock.calls.map(([args]) => args);
    const mouseIdx = tmuxCalls.findIndex((args) => args[0] === 'set-option');
    const attachIdx = tmuxCalls.findIndex((args) => args[0] === 'attach-session');
    expect(mouseIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(mouseIdx).toBeLessThan(attachIdx);
  });

  it('preserves a valid detached session when attach-session is interrupted', () => {
    vi.mocked(tmuxExec).mockImplementation((args: string[]) => {
      if (args[0] === 'attach-session') {
        throw new Error('attach interrupted');
      }
      return '';
    });

    runClaude('/tmp', [], 'sid');

    const tmuxCalls = vi.mocked(tmuxExec).mock.calls.map(([args]) => args);
    expect(tmuxCalls.map((args) => args[0])).toEqual([
      'new-session',
      'set-option',
      'attach-session',
      'has-session',
    ]);
    expect(tmuxCalls.some((args) => args[0] === 'kill-session')).toBe(false);
    expect(vi.mocked(execFileSync).mock.calls.find(([cmd]) => cmd === 'claude')).toBeUndefined();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('falls back to direct launch when detached session creation fails', () => {
    vi.mocked(tmuxExec).mockImplementation((args: string[]) => {
      if (args[0] === 'new-session') {
        throw new Error('tmux launch failed');
      }
      return '';
    });

    runClaude('/tmp', ['--dangerously-skip-permissions'], 'sid');

    expect(vi.mocked(tmuxExec).mock.calls).toHaveLength(1);
    expect(vi.mocked(execFileSync).mock.calls.find(([cmd, args]) => cmd === 'claude' && (args as string[])[0] === '--dangerously-skip-permissions')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// runClaude — inside-tmux mouse configuration (issue #890)
// ---------------------------------------------------------------------------
describe('runClaude inside-tmux — mouse configuration (issue #890)', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('inside-tmux');
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('enables mouse mode before launching claude', () => {
    runClaude('/tmp', [], 'sid');

    // tmuxExec should have been called for mouse config
    const tmuxCalls = vi.mocked(tmuxExec).mock.calls;
    expect(tmuxCalls.length).toBeGreaterThanOrEqual(1);
    expect(tmuxCalls[0][0]).toEqual(['set-option', 'mouse', 'on']);

    // execFileSync should have been called for claude
    const claudeCalls = vi.mocked(execFileSync).mock.calls;
    expect(claudeCalls.find(([cmd]) => cmd === 'claude')).toBeDefined();
  });

  it('still launches claude even if tmux mouse config fails', () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === 'tmux') throw new Error('tmux set-option failed');
      return Buffer.from('');
    });

    runClaude('/tmp', [], 'sid');

    // tmux calls fail but claude should still be called
    const calls = vi.mocked(execFileSync).mock.calls;
    const claudeCall = calls.find(([cmd]) => cmd === 'claude');
    expect(claudeCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// extractTelegramFlag
// ---------------------------------------------------------------------------
describe('extractTelegramFlag', () => {
  it('returns telegramEnabled=undefined when --telegram flag is not present', () => {
    const result = extractTelegramFlag(['--madmax']);
    expect(result.telegramEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual(['--madmax']);
  });

  it('enables telegram with bare --telegram flag', () => {
    const result = extractTelegramFlag(['--telegram']);
    expect(result.telegramEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('enables telegram with --telegram=true', () => {
    const result = extractTelegramFlag(['--telegram=true']);
    expect(result.telegramEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('disables telegram with --telegram=false', () => {
    const result = extractTelegramFlag(['--telegram=false']);
    expect(result.telegramEnabled).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('enables telegram with --telegram=1', () => {
    const result = extractTelegramFlag(['--telegram=1']);
    expect(result.telegramEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('disables telegram with --telegram=0', () => {
    const result = extractTelegramFlag(['--telegram=0']);
    expect(result.telegramEnabled).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('strips --telegram from remainingArgs', () => {
    const result = extractTelegramFlag(['--madmax', '--telegram', '--print']);
    expect(result.telegramEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--madmax', '--print']);
  });

  it('bare --telegram does NOT consume the next positional arg', () => {
    const result = extractTelegramFlag(['--telegram', 'myfile.txt']);
    expect(result.telegramEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['myfile.txt']);
  });

  it('returns telegramEnabled=undefined for empty args', () => {
    const result = extractTelegramFlag([]);
    expect(result.telegramEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual([]);
  });

  it('handles multiple flags: extracts --telegram and preserves --discord and positional args', () => {
    const result = extractTelegramFlag(['--telegram', '--discord', 'file.txt']);
    expect(result.telegramEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--discord', 'file.txt']);
  });
});

// ---------------------------------------------------------------------------
// extractDiscordFlag
// ---------------------------------------------------------------------------
describe('extractDiscordFlag', () => {
  it('returns discordEnabled=undefined when --discord flag is not present', () => {
    const result = extractDiscordFlag(['--madmax']);
    expect(result.discordEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual(['--madmax']);
  });

  it('enables discord with bare --discord flag', () => {
    const result = extractDiscordFlag(['--discord']);
    expect(result.discordEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('enables discord with --discord=true', () => {
    const result = extractDiscordFlag(['--discord=true']);
    expect(result.discordEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('disables discord with --discord=false', () => {
    const result = extractDiscordFlag(['--discord=false']);
    expect(result.discordEnabled).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('enables discord with --discord=1', () => {
    const result = extractDiscordFlag(['--discord=1']);
    expect(result.discordEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('disables discord with --discord=0', () => {
    const result = extractDiscordFlag(['--discord=0']);
    expect(result.discordEnabled).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('strips --discord from remainingArgs', () => {
    const result = extractDiscordFlag(['--madmax', '--discord', '--print']);
    expect(result.discordEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--madmax', '--print']);
  });

  it('bare --discord does NOT consume the next positional arg', () => {
    const result = extractDiscordFlag(['--discord', 'myfile.txt']);
    expect(result.discordEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['myfile.txt']);
  });

  it('returns discordEnabled=undefined for empty args', () => {
    const result = extractDiscordFlag([]);
    expect(result.discordEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual([]);
  });

  it('handles multiple flags: extracts --discord and preserves --telegram and positional args', () => {
    const result = extractDiscordFlag(['--telegram', '--discord', 'file.txt']);
    expect(result.discordEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--telegram', 'file.txt']);
  });
});

// ---------------------------------------------------------------------------
// extractOpenClawFlag
// ---------------------------------------------------------------------------
describe('extractOpenClawFlag', () => {
  it('returns openclawEnabled=undefined with no --openclaw flag', () => {
    const result = extractOpenClawFlag(['--madmax']);
    expect(result.openclawEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual(['--madmax']);
  });

  it('enables openclaw with bare --openclaw flag', () => {
    const result = extractOpenClawFlag(['--openclaw']);
    expect(result.openclawEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('strips --openclaw from remainingArgs', () => {
    const result = extractOpenClawFlag(['--madmax', '--openclaw', '--print']);
    expect(result.openclawEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--madmax', '--print']);
  });

  it('bare --openclaw does NOT consume the next positional arg', () => {
    const result = extractOpenClawFlag(['--openclaw', 'myfile.txt']);
    expect(result.openclawEnabled).toBe(true);
    // myfile.txt must remain as a positional arg
    expect(result.remainingArgs).toEqual(['myfile.txt']);
  });

  it('enables openclaw with --openclaw=true', () => {
    const result = extractOpenClawFlag(['--openclaw=true']);
    expect(result.openclawEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('enables openclaw with --openclaw=1', () => {
    const result = extractOpenClawFlag(['--openclaw=1']);
    expect(result.openclawEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('disables openclaw with --openclaw=false', () => {
    const result = extractOpenClawFlag(['--openclaw=false']);
    expect(result.openclawEnabled).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('disables openclaw with --openclaw=0', () => {
    const result = extractOpenClawFlag(['--openclaw=0']);
    expect(result.openclawEnabled).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('handles --openclaw=FALSE (case insensitive)', () => {
    const result = extractOpenClawFlag(['--openclaw=FALSE']);
    expect(result.openclawEnabled).toBe(false);
  });

  it('returns openclawEnabled=undefined for empty args', () => {
    const result = extractOpenClawFlag([]);
    expect(result.openclawEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual([]);
  });

  it('handles multiple flags correctly', () => {
    const result = extractOpenClawFlag(['--madmax', '--openclaw', '--print', 'myfile.txt']);
    expect(result.openclawEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--madmax', '--print', 'myfile.txt']);
  });
});

// ---------------------------------------------------------------------------
// extractSlackFlag
// ---------------------------------------------------------------------------
describe('extractSlackFlag', () => {
  it('returns slackEnabled=undefined when --slack flag is not present', () => {
    const result = extractSlackFlag(['--madmax']);
    expect(result.slackEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual(['--madmax']);
  });

  it('enables slack with bare --slack flag', () => {
    const result = extractSlackFlag(['--slack']);
    expect(result.slackEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('enables slack with --slack=true', () => {
    const result = extractSlackFlag(['--slack=true']);
    expect(result.slackEnabled).toBe(true);
  });

  it('disables slack with --slack=false', () => {
    const result = extractSlackFlag(['--slack=false']);
    expect(result.slackEnabled).toBe(false);
  });

  it('enables slack with --slack=1', () => {
    const result = extractSlackFlag(['--slack=1']);
    expect(result.slackEnabled).toBe(true);
  });

  it('disables slack with --slack=0', () => {
    const result = extractSlackFlag(['--slack=0']);
    expect(result.slackEnabled).toBe(false);
  });

  it('strips --slack from remainingArgs', () => {
    const result = extractSlackFlag(['--madmax', '--slack', '--print']);
    expect(result.slackEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--madmax', '--print']);
  });

  it('bare --slack does NOT consume the next positional arg', () => {
    const result = extractSlackFlag(['--slack', 'myfile.txt']);
    expect(result.slackEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['myfile.txt']);
  });

  it('returns slackEnabled=undefined for empty args', () => {
    const result = extractSlackFlag([]);
    expect(result.slackEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractWebhookFlag
// ---------------------------------------------------------------------------
describe('extractWebhookFlag', () => {
  it('returns webhookEnabled=undefined when --webhook flag is not present', () => {
    const result = extractWebhookFlag(['--madmax']);
    expect(result.webhookEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual(['--madmax']);
  });

  it('enables webhook with bare --webhook flag', () => {
    const result = extractWebhookFlag(['--webhook']);
    expect(result.webhookEnabled).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('enables webhook with --webhook=true', () => {
    const result = extractWebhookFlag(['--webhook=true']);
    expect(result.webhookEnabled).toBe(true);
  });

  it('disables webhook with --webhook=false', () => {
    const result = extractWebhookFlag(['--webhook=false']);
    expect(result.webhookEnabled).toBe(false);
  });

  it('enables webhook with --webhook=1', () => {
    const result = extractWebhookFlag(['--webhook=1']);
    expect(result.webhookEnabled).toBe(true);
  });

  it('disables webhook with --webhook=0', () => {
    const result = extractWebhookFlag(['--webhook=0']);
    expect(result.webhookEnabled).toBe(false);
  });

  it('strips --webhook from remainingArgs', () => {
    const result = extractWebhookFlag(['--madmax', '--webhook', '--print']);
    expect(result.webhookEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['--madmax', '--print']);
  });

  it('bare --webhook does NOT consume the next positional arg', () => {
    const result = extractWebhookFlag(['--webhook', 'myfile.txt']);
    expect(result.webhookEnabled).toBe(true);
    expect(result.remainingArgs).toEqual(['myfile.txt']);
  });

  it('returns webhookEnabled=undefined for empty args', () => {
    const result = extractWebhookFlag([]);
    expect(result.webhookEnabled).toBeUndefined();
    expect(result.remainingArgs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// launchCommand — env var propagation (Issue: --flag=false must override inherited env)
// ---------------------------------------------------------------------------
describe('launchCommand — env var propagation', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  // Save original env values to restore after each test
  const envKeys = ['OMC_NOTIFY', 'OMC_OPENCLAW', 'OMC_TELEGRAM', 'OMC_DISCORD', 'OMC_SLACK', 'OMC_WEBHOOK', 'CLAUDECODE'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Save and clear env
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Mock execFileSync to prevent actual claude launch
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('direct');
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    // Restore env
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('bare --telegram sets OMC_TELEGRAM to 1', async () => {
    await launchCommand(['--telegram']);
    expect(process.env.OMC_TELEGRAM).toBe('1');
  });

  it('bare --discord sets OMC_DISCORD to 1', async () => {
    await launchCommand(['--discord']);
    expect(process.env.OMC_DISCORD).toBe('1');
  });

  it('bare --slack sets OMC_SLACK to 1', async () => {
    await launchCommand(['--slack']);
    expect(process.env.OMC_SLACK).toBe('1');
  });

  it('bare --webhook sets OMC_WEBHOOK to 1', async () => {
    await launchCommand(['--webhook']);
    expect(process.env.OMC_WEBHOOK).toBe('1');
  });

  it('bare --openclaw sets OMC_OPENCLAW to 1', async () => {
    await launchCommand(['--openclaw']);
    expect(process.env.OMC_OPENCLAW).toBe('1');
  });

  it('--telegram=false overrides inherited OMC_TELEGRAM=1', async () => {
    process.env.OMC_TELEGRAM = '1';
    await launchCommand(['--telegram=false']);
    expect(process.env.OMC_TELEGRAM).toBe('0');
  });

  it('--discord=false overrides inherited OMC_DISCORD=1', async () => {
    process.env.OMC_DISCORD = '1';
    await launchCommand(['--discord=false']);
    expect(process.env.OMC_DISCORD).toBe('0');
  });

  it('--slack=false overrides inherited OMC_SLACK=1', async () => {
    process.env.OMC_SLACK = '1';
    await launchCommand(['--slack=false']);
    expect(process.env.OMC_SLACK).toBe('0');
  });

  it('--webhook=false overrides inherited OMC_WEBHOOK=1', async () => {
    process.env.OMC_WEBHOOK = '1';
    await launchCommand(['--webhook=false']);
    expect(process.env.OMC_WEBHOOK).toBe('0');
  });

  it('--openclaw=false overrides inherited OMC_OPENCLAW=1', async () => {
    process.env.OMC_OPENCLAW = '1';
    await launchCommand(['--openclaw=false']);
    expect(process.env.OMC_OPENCLAW).toBe('0');
  });

  it('--telegram=0 overrides inherited OMC_TELEGRAM=1', async () => {
    process.env.OMC_TELEGRAM = '1';
    await launchCommand(['--telegram=0']);
    expect(process.env.OMC_TELEGRAM).toBe('0');
  });

  it('preserves inherited platform env vars when no platform flags are passed', async () => {
    process.env.OMC_TELEGRAM = '1';
    process.env.OMC_DISCORD = '1';
    process.env.OMC_SLACK = '1';
    process.env.OMC_WEBHOOK = '1';

    await launchCommand(['--print']);

    expect(process.env.OMC_TELEGRAM).toBe('1');
    expect(process.env.OMC_DISCORD).toBe('1');
    expect(process.env.OMC_SLACK).toBe('1');
    expect(process.env.OMC_WEBHOOK).toBe('1');
  });

  it('OMC flags are stripped from args passed to Claude', async () => {
    await launchCommand(['--telegram', '--discord', '--slack', '--webhook', '--openclaw', '--print']);

    const calls = vi.mocked(execFileSync).mock.calls;
    const claudeCall = calls.find(([cmd]) => cmd === 'claude');
    expect(claudeCall).toBeDefined();
    const claudeArgs = claudeCall![1] as string[];
    expect(claudeArgs).not.toContain('--telegram');
    expect(claudeArgs).not.toContain('--discord');
    expect(claudeArgs).not.toContain('--slack');
    expect(claudeArgs).not.toContain('--webhook');
    expect(claudeArgs).not.toContain('--openclaw');
    expect(claudeArgs).toContain('--print');
  });
});

describe('prepareOmcLaunchConfigDir / launchCommand OMC companion loading', () => {
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.HOME;
  let tempRoot: string | null = null;

  const originalClaudecode = process.env.CLAUDECODE;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.CLAUDECODE;
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-launch-profile-'));
    process.env.HOME = join(tempRoot, 'home');
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('direct');
    // Clear CLAUDECODE to avoid "already inside CC session" exit
    delete process.env.CLAUDECODE;
  });

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    if (originalClaudecode === undefined) {
      delete process.env.CLAUDECODE;
    } else {
      process.env.CLAUDECODE = originalClaudecode;
    }
  });

  it('uses a runtime launch profile when a preserved CLAUDE-omc.md companion exists', async () => {
    const configDir = join(tempRoot!, '.claude');
    mkdirSync(join(configDir, 'skills'), { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User base config\n');
    writeFileSync(join(configDir, 'CLAUDE-omc.md'), '<!-- OMC:START -->\n# OMC companion\n<!-- OMC:END -->\n');
    writeFileSync(join(configDir, 'settings.json'), '{"hooks":{}}');

    process.env.CLAUDE_CONFIG_DIR = configDir;

    await launchCommand(['--print']);

    const runtimeDir = join(configDir, '.omc-launch');
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(runtimeDir);
    expect(existsSync(join(runtimeDir, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(runtimeDir, 'CLAUDE.md'), 'utf-8')).toContain('# OMC companion');
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf-8')).toBe('# User base config\n');
    expect(existsSync(join(runtimeDir, 'settings.json'))).toBe(true);
  });

  it('repairs retired team MCP entries in the runtime settings copy', () => {
    const configDir = join(tempRoot!, '.claude');
    mkdirSync(join(configDir, 'skills'), { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE-omc.md'), '<!-- OMC:START -->\n# OMC companion\n<!-- OMC:END -->\n');
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
      theme: 'dark',
      mcpServers: {
        team: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/bridge/team-mcp.cjs'],
        },
        exa: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs'],
        },
      },
    }, null, 2));

    const runtimeDir = prepareOmcLaunchConfigDir(configDir);
    const runtimeSettings = JSON.parse(readFileSync(join(runtimeDir, 'settings.json'), 'utf-8')) as {
      theme?: string;
      mcpServers?: Record<string, unknown>;
    };

    expect(runtimeSettings.theme).toBe('dark');
    expect(runtimeSettings.mcpServers).toBeDefined();
    expect(runtimeSettings.mcpServers?.team).toBeUndefined();
    expect(runtimeSettings.mcpServers?.exa).toBeDefined();
  });

  it('mirrors keybindings.json and rules/ into the runtime config dir', () => {
    const configDir = join(tempRoot!, '.claude');
    mkdirSync(join(configDir, 'rules'), { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE-omc.md'), '<!-- OMC:START -->\n# OMC\n<!-- OMC:END -->\n');
    writeFileSync(join(configDir, 'keybindings.json'), '{"bindings":[]}');
    writeFileSync(join(configDir, 'rules', 'my-rule.md'), '# Rule');

    const runtimeDir = prepareOmcLaunchConfigDir(configDir);
    expect(runtimeDir).not.toBe(configDir);
    expect(existsSync(join(runtimeDir, 'keybindings.json'))).toBe(true);
    expect(existsSync(join(runtimeDir, 'rules'))).toBe(true);
  });

  it('leaves CLAUDE_CONFIG_DIR unchanged when no preserved companion exists', () => {
    const configDir = join(tempRoot!, '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '<!-- OMC:START -->\n# OMC base\n<!-- OMC:END -->\n');

    expect(prepareOmcLaunchConfigDir(configDir)).toBe(configDir);
    expect(existsSync(join(configDir, '.omc-launch'))).toBe(false);
  });

  it('does not keep CLAUDE_CONFIG_DIR set when it resolves to the default ~/.claude path', async () => {
    const configDir = join(tempRoot!, 'home', '.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# User config\n');
    process.env.CLAUDE_CONFIG_DIR = configDir;

    await launchCommand(['--print']);

    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('preserves explicit non-default CLAUDE_CONFIG_DIR values when no companion exists', async () => {
    const configDir = join(tempRoot!, 'custom-claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), '# Custom user config\n');
    process.env.CLAUDE_CONFIG_DIR = configDir;

    await launchCommand(['--print']);

    expect(process.env.CLAUDE_CONFIG_DIR).toBe(configDir);
  });
});

// ---------------------------------------------------------------------------
// isPrintMode
// ---------------------------------------------------------------------------
describe('isPrintMode', () => {
  it('detects --print flag', () => {
    expect(isPrintMode(['--print', 'say hello'])).toBe(true);
  });

  it('detects -p flag', () => {
    expect(isPrintMode(['-p', 'say hello'])).toBe(true);
  });

  it('returns false when no print flag', () => {
    expect(isPrintMode(['--madmax', '--verbose'])).toBe(false);
  });

  it('returns false for empty args', () => {
    expect(isPrintMode([])).toBe(false);
  });

  it('detects --print among other flags', () => {
    expect(isPrintMode(['--madmax', '--print', 'say hello'])).toBe(true);
  });

  it('does not match partial flags like --print-something', () => {
    expect(isPrintMode(['--print-something'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runClaude — print mode bypasses tmux (issue #1665)
// ---------------------------------------------------------------------------
describe('runClaude — print mode bypasses tmux (issue #1665)', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('runs claude directly when --print is present (outside-tmux policy)', () => {
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('outside-tmux');

    runClaude('/tmp', ['--print', 'say hello'], 'sid');

    const calls = vi.mocked(execFileSync).mock.calls;
    // Should call claude directly, NOT tmux
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('claude');
    expect(calls[0][1]).toEqual(['--print', 'say hello']);
    expect(calls[0][2]).toEqual(expect.objectContaining({ stdio: 'inherit' }));
  });

  it('runs claude directly when -p is present (outside-tmux policy)', () => {
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('outside-tmux');

    runClaude('/tmp', ['-p', 'say hello'], 'sid');

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('claude');
  });

  it('runs claude directly when --print is present (inside-tmux policy)', () => {
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('inside-tmux');

    runClaude('/tmp', ['--dangerously-skip-permissions', '--print', 'say hello'], 'sid');

    const calls = vi.mocked(execFileSync).mock.calls;
    // Should NOT call tmux set-option (mouse config), just claude directly
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('claude');
  });

  it('does not bypass tmux when --print is absent', () => {
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('outside-tmux');

    runClaude('/tmp', ['--dangerously-skip-permissions'], 'sid');

    // tmux calls go through tmuxExec, not execFileSync
    expect(vi.mocked(tmuxExec).mock.calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildEnvExportPrefix — unit tests
// ---------------------------------------------------------------------------
describe('buildEnvExportPrefix', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const testVars = ['TEST_VAR_A', 'TEST_VAR_B', 'TEST_VAR_C'];

  beforeEach(() => {
    for (const key of testVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of testVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns empty string when no vars are set', () => {
    expect(buildEnvExportPrefix(testVars)).toBe('');
  });

  it('builds export statement for a single set var', () => {
    process.env.TEST_VAR_A = '/some/path';
    const result = buildEnvExportPrefix(['TEST_VAR_A']);
    expect(result).toBe('export TEST_VAR_A=/some/path; ');
  });

  it('builds semicolon-separated exports for multiple set vars', () => {
    process.env.TEST_VAR_A = 'aaa';
    process.env.TEST_VAR_B = 'bbb';
    const result = buildEnvExportPrefix(['TEST_VAR_A', 'TEST_VAR_B', 'TEST_VAR_C']);
    expect(result).toBe('export TEST_VAR_A=aaa; export TEST_VAR_B=bbb; ');
  });

  it('skips unset vars and only exports defined ones', () => {
    process.env.TEST_VAR_B = 'only-b';
    const result = buildEnvExportPrefix(testVars);
    expect(result).toBe('export TEST_VAR_B=only-b; ');
  });

  it('exports vars with empty string values', () => {
    process.env.TEST_VAR_A = '';
    const result = buildEnvExportPrefix(['TEST_VAR_A']);
    expect(result).toBe('export TEST_VAR_A=; ');
  });
});

// ---------------------------------------------------------------------------
// buildEnvExportPrefix — shell quoting (uses real quoteShellArg via mock passthrough)
// ---------------------------------------------------------------------------
describe('buildEnvExportPrefix — quoting delegation', () => {
  const saved = process.env.TEST_QUOTE_VAR;

  afterEach(() => {
    if (saved !== undefined) {
      process.env.TEST_QUOTE_VAR = saved;
    } else {
      delete process.env.TEST_QUOTE_VAR;
    }
  });

  it('delegates value quoting to quoteShellArg', async () => {
    process.env.TEST_QUOTE_VAR = 'has spaces';
    buildEnvExportPrefix(['TEST_QUOTE_VAR']);
    const { quoteShellArg: mockQuote } = vi.mocked(await import('../tmux-utils.js'));
    expect(mockQuote).toHaveBeenCalledWith('has spaces');
  });
});

// ---------------------------------------------------------------------------
// TMUX_ENV_FORWARD — allowlist contract
// ---------------------------------------------------------------------------
describe('TMUX_ENV_FORWARD allowlist', () => {
  it('includes CLAUDE_CONFIG_DIR', () => {
    expect(TMUX_ENV_FORWARD).toContain('CLAUDE_CONFIG_DIR');
  });

  it('includes all OMC launch flags', () => {
    for (const name of ['OMC_NOTIFY', 'OMC_OPENCLAW', 'OMC_TELEGRAM', 'OMC_DISCORD', 'OMC_SLACK', 'OMC_WEBHOOK']) {
      expect(TMUX_ENV_FORWARD).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// runClaude outside-tmux — env forwarding into tmux command
// ---------------------------------------------------------------------------
describe('runClaude outside-tmux — env forwarding', () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    vi.resetAllMocks();
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(''));
    (resolveLaunchPolicy as ReturnType<typeof vi.fn>).mockReturnValue('outside-tmux');
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('injects CLAUDE_CONFIG_DIR export into the tmux shell command', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/config';

    runClaude('/tmp', [], 'sid');

    const wrapCall = vi.mocked(wrapWithLoginShell).mock.calls[0];
    expect(wrapCall).toBeDefined();
    expect(wrapCall[0]).toContain('export CLAUDE_CONFIG_DIR=/custom/config');
  });

  it('places env exports before the sleep/claude command', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/config';

    runClaude('/tmp', [], 'sid');

    const cmdString = vi.mocked(wrapWithLoginShell).mock.calls[0][0];
    const exportIdx = cmdString.indexOf('export CLAUDE_CONFIG_DIR');
    const sleepIdx = cmdString.indexOf('sleep 0.3');
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(sleepIdx).toBeGreaterThan(exportIdx);
  });

  it('does not inject exports when no forwarded vars are set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.OMC_NOTIFY;
    delete process.env.OMC_OPENCLAW;
    delete process.env.OMC_TELEGRAM;
    delete process.env.OMC_DISCORD;
    delete process.env.OMC_SLACK;
    delete process.env.OMC_WEBHOOK;
    delete process.env.OMC_PLUGIN_ROOT;

    runClaude('/tmp', [], 'sid');

    const cmdString = vi.mocked(wrapWithLoginShell).mock.calls[0][0];
    expect(cmdString).not.toContain('export ');
  });
});
