/**
 * Tests for src/cli/launch.ts
 *
 * Covers:
 * - Exit code propagation (runClaude direct / inside-tmux)
 * - No OMC HUD pane spawning in tmux launch paths
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';

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
  quoteShellArg: vi.fn((s: string) => s),
  isClaudeAvailable: vi.fn(() => true),
}));

import { runClaude, launchCommand, extractNotifyFlag, extractOpenClawFlag, extractTelegramFlag, extractDiscordFlag, extractSlackFlag, extractWebhookFlag, normalizeClaudeLaunchArgs } from '../launch.js';
import {
  resolveLaunchPolicy,
  buildTmuxShellCommand,
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

    const calls = vi.mocked(execFileSync).mock.calls;
    const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
    expect(tmuxCall).toBeDefined();

    const tmuxArgs = tmuxCall![1] as string[];
    expect(tmuxArgs).not.toContain('split-window');
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

    const calls = vi.mocked(execFileSync).mock.calls;
    const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
    expect(tmuxCall).toBeDefined();

    const tmuxArgs = tmuxCall![1] as string[];
    // Must use -t <sessionName> targeting, not -g (global)
    const setOptionIdx = tmuxArgs.indexOf('set-option');
    expect(setOptionIdx).toBeGreaterThanOrEqual(0);
    expect(tmuxArgs[setOptionIdx + 1]).toBe('-t');
    expect(tmuxArgs[setOptionIdx + 2]).toBe('test-session');
    expect(tmuxArgs[setOptionIdx + 3]).toBe('mouse');
    expect(tmuxArgs[setOptionIdx + 4]).toBe('on');
    // Must NOT use -g (global)
    expect(tmuxArgs).not.toContain('-g');
  });

  it('does not set terminal-overrides in tmux args', () => {
    runClaude('/tmp', [], 'sid');

    const calls = vi.mocked(execFileSync).mock.calls;
    const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
    const tmuxArgs = tmuxCall![1] as string[];

    expect(tmuxArgs).not.toContain('terminal-overrides');
    expect(tmuxArgs).not.toContain('*:smcup@:rmcup@');
  });

  it('places mouse mode setup before attach-session', () => {
    runClaude('/tmp', [], 'sid');

    const calls = vi.mocked(execFileSync).mock.calls;
    const tmuxCall = calls.find(([cmd]) => cmd === 'tmux');
    const tmuxArgs = tmuxCall![1] as string[];

    const mouseIdx = tmuxArgs.indexOf('mouse');
    const attachIdx = tmuxArgs.indexOf('attach-session');
    expect(mouseIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(mouseIdx).toBeLessThan(attachIdx);
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

    const calls = vi.mocked(execFileSync).mock.calls;

    // First call should be tmux set-option for mouse config
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0][0]).toBe('tmux');
    expect(calls[0][1]).toEqual(['set-option', 'mouse', 'on']);

    // Second call should be claude
    expect(calls[1][0]).toBe('claude');
  });

  it('still launches claude even if tmux mouse config fails', () => {
    let callCount = 0;
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      callCount++;
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
  it('returns openclawEnabled=false with no --openclaw flag', () => {
    const result = extractOpenClawFlag(['--madmax']);
    expect(result.openclawEnabled).toBe(false);
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

  it('returns openclawEnabled=false for empty args', () => {
    const result = extractOpenClawFlag([]);
    expect(result.openclawEnabled).toBe(false);
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
