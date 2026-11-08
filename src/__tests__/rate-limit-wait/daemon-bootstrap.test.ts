import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getUsageProfileHash } from '../../features/rate-limit-wait/daemon-state.js';
import type { DaemonConfig } from '../../features/rate-limit-wait/types.js';

const { mockSpawn, mockResolveDaemonModulePath, mockIsTmuxAvailable } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockResolveDaemonModulePath: vi.fn(),
  mockIsTmuxAvailable: vi.fn(() => true),
}));

function currentUsageProfileHash(): string | null {
  return getUsageProfileHash(false);
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

vi.mock('../../utils/daemon-module-path.js', () => ({
  resolveDaemonModulePath: mockResolveDaemonModulePath,
}));

vi.mock('../../features/rate-limit-wait/tmux-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/rate-limit-wait/tmux-detector.js')>(
    '../../features/rate-limit-wait/tmux-detector.js',
  );
  return {
    ...actual,
    isTmuxAvailable: mockIsTmuxAvailable,
  };
});

describe('daemon bootstrap', () => {
  const originalEnv = { ...process.env };
  const testDir = join(tmpdir(), `omc-daemon-bootstrap-test-${Date.now()}`);
  let startDaemon: typeof import('../../features/rate-limit-wait/daemon.js').startDaemon;

  beforeEach(async () => {
    vi.resetModules();
    mockSpawn.mockReset();
    mockResolveDaemonModulePath.mockReset();
    mockIsTmuxAvailable.mockReset();
    mockIsTmuxAvailable.mockReturnValue(true);
    mockResolveDaemonModulePath.mockReturnValue('/repo/dist/features/rate-limit-wait/daemon.js');

    ({ startDaemon } = await import('../../features/rate-limit-wait/daemon.js'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(testDir, { recursive: true, force: true });
  });

  it('uses resolved daemon module path and sanitized child env when starting', () => {
    const unref = vi.fn();
    mockSpawn.mockReturnValue({ pid: 4242, unref } as any);

    process.env.PATH = '/usr/bin:/bin';
    process.env.TMUX = '/tmp/tmux-1000/default,100,0';
    process.env.OMC_STATE_DIR = '/tmp/omc-central-state';
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-profile';
    process.env.CLAUDE_SESSION_ID = 'session-current';
    process.env.CLAUDECODE_SESSION_ID = 'session-legacy-alias';
    process.env.ANTHROPIC_API_KEY = 'super-secret';
    process.env.GITHUB_TOKEN = 'token-should-not-leak';

    const config: DaemonConfig = {
      stateFilePath: join(testDir, 'state.json'),
      pidFilePath: join(testDir, 'daemon.pid'),
      logFilePath: join(testDir, 'daemon.log'),
      pollIntervalMs: 1234,
      verbose: true,
    };

    const result = startDaemon(config);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Daemon started with PID 4242');
    expect(unref).toHaveBeenCalledTimes(1);

    expect(mockResolveDaemonModulePath).toHaveBeenCalledTimes(1);
    expect(mockResolveDaemonModulePath).toHaveBeenCalledWith(
      expect.any(String),
      ['features', 'rate-limit-wait', 'daemon.js'],
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, spawnOptions] = mockSpawn.mock.calls[0]!;
    expect(command).toBe('node');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain("import(\"file:///repo/dist/features/rate-limit-wait/daemon.js\")");
    expect(spawnOptions?.detached).toBe(true);
    expect(spawnOptions?.stdio).toBe('ignore');

    const childEnv = spawnOptions?.env as Record<string, string | undefined>;
    expect(childEnv.PATH).toBe('/usr/bin:/bin');
    expect(childEnv.TMUX).toBe('/tmp/tmux-1000/default,100,0');
    expect(childEnv.OMC_STATE_DIR).toBe('/tmp/omc-central-state');
    expect(childEnv.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-profile');
    // A detached daemon must not pin itself to the launching session: that
    // session's cache is removed at session end, while another live session
    // may have the version the daemon should use on its next poll.
    expect(childEnv.CLAUDE_SESSION_ID).toBeUndefined();
    expect(childEnv.CLAUDECODE_SESSION_ID).toBeUndefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();

    const configPath = childEnv.OMC_DAEMON_CONFIG_FILE;
    expect(configPath).toBeTruthy();
    expect(existsSync(configPath!)).toBe(true);
    const persistedConfig = JSON.parse(readFileSync(configPath!, 'utf-8')) as Record<string, unknown>;
    expect(persistedConfig.pollIntervalMs).toBe(1234);
    expect(persistedConfig.verbose).toBe(true);
  });

  it('uses a file URL in daemon import script so Windows backslashes are not parsed as JS escapes', () => {
    const unref = vi.fn();
    mockSpawn.mockReturnValue({ pid: 4243, unref } as any);
    mockResolveDaemonModulePath.mockReturnValue('C:\\Users\\soung\\AppData\\Roaming\\npm\\node_modules\\oh-my-claude-sisyphus\\dist\\features\\rate-limit-wait\\daemon.js');

    const config: DaemonConfig = {
      stateFilePath: join(testDir, 'state.json'),
      pidFilePath: join(testDir, 'daemon.pid'),
      logFilePath: join(testDir, 'daemon.log'),
    };

    const result = startDaemon(config);

    expect(result.success).toBe(true);
    const [, args] = mockSpawn.mock.calls[0]!;
    const daemonScript = args[1] as string;

    expect(daemonScript).toContain('import("file://');
    expect(daemonScript).not.toContain("import('C:\\Users");
    expect(daemonScript).not.toContain('\\features\\rate-limit-wait\\daemon.js');
  });

  it('preserves quota recovery only for the profile that recorded it', () => {
    const unref = vi.fn();
    mockSpawn.mockReturnValue({ pid: 4244, unref } as any);

    const config: DaemonConfig = {
      stateFilePath: join(testDir, 'state.json'),
      pidFilePath: join(testDir, 'daemon.pid'),
      logFilePath: join(testDir, 'daemon.log'),
    };
    mkdirSync(testDir, { recursive: true });
    const profileA = join(testDir, 'profile-a');
    mkdirSync(profileA, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = profileA;
    writeFileSync(join(profileA, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'profile-a-access',
        refreshToken: 'profile-a-refresh',
        oauthAccount: { uuid: 'profile-a' },
      },
    }));
    writeFileSync(config.stateFilePath!, JSON.stringify({
      isRunning: false,
      pid: null,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastPollAt: null,
      rateLimitStatus: {
        fiveHourLimited: true,
        weeklyLimited: false,
        monthlyLimited: false,
        isLimited: true,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
        monthlyResetsAt: null,
        nextResetAt: null,
        timeUntilResetMs: null,
        lastCheckedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      lastConfirmedLimited: true,
      usageProfileHash: currentUsageProfileHash(),
      blockedPanes: [{
        id: '%test',
        session: 'test',
        windowIndex: 0,
        windowName: 'test',
        paneIndex: 0,
        isActive: false,
        analysis: { hasClaudeCode: true, hasRateLimitMessage: true, isBlocked: true, confidence: 1 },
        firstDetectedAt: new Date('2026-01-01T00:00:00.000Z'),
        resumeAttempted: false,
      }],
      resumedPaneIds: [],
      totalResumeAttempts: 0,
      successfulResumes: 0,
      errorCount: 0,
    }));

    const result = startDaemon(config);

    expect(result.success).toBe(true);
    expect(result.state).toMatchObject({
      isRunning: true,
      pid: 4244,
      lastConfirmedLimited: true,
      rateLimitStatus: { isLimited: true },
      blockedPanes: [expect.objectContaining({ id: '%test' })],
    });
    const persistedState = JSON.parse(readFileSync(config.stateFilePath!, 'utf-8'));
    expect(persistedState.lastConfirmedLimited).toBe(true);
    expect(persistedState.blockedPanes).toMatchObject([{ id: '%test' }]);
    expect(unref).toHaveBeenCalledOnce();

    rmSync(config.pidFilePath!, { force: true });
    const profileB = join(testDir, 'profile-b');
    mkdirSync(profileB, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = profileB;
    writeFileSync(join(profileB, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'profile-b-access',
        refreshToken: 'profile-b-refresh',
        oauthAccount: { uuid: 'profile-b' },
      },
    }));
    mockSpawn.mockReturnValue({ pid: 4245, unref: vi.fn() } as any);

    const switchedProfile = startDaemon(config);

    expect(switchedProfile.state).toMatchObject({
      lastConfirmedLimited: false,
      usageProfileHash: currentUsageProfileHash(),
      rateLimitStatus: null,
      blockedPanes: [],
      resumedPaneIds: [],
    });
  });

  it('returns already running when config pid file points to a live process', () => {
    const config: DaemonConfig = {
      stateFilePath: join(testDir, 'state.json'),
      pidFilePath: join(testDir, 'daemon.pid'),
      logFilePath: join(testDir, 'daemon.log'),
    };

    // Use current process PID so isDaemonRunning() reports true.
    mkdirSync(testDir, { recursive: true });
    writeFileSync(config.pidFilePath!, String(process.pid));

    const result = startDaemon(config);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Daemon is already running');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
