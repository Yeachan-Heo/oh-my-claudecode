import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

function makeStdin(withRateLimits = false) {
  return {
    cwd: '/tmp/worktree',
    transcript_path: '/tmp/worktree/transcript.jsonl',
    model: { id: 'claude-test' },
    context_window: {
      used_percentage: 12,
      current_usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      context_window_size: 100,
    },
    ...(withRateLimits
      ? {
        rate_limits: {
          five_hour: { used_percentage: 11, resets_at: 1776348000 },
          seven_day: { used_percentage: 2, resets_at: 1776916800 },
        },
      }
      : {}),
  };
}

function makeConfig(rateLimits = false) {
  return {
    preset: 'focused',
    elements: {
      rateLimits,
      apiKeySource: false,
      safeMode: false,
      missionBoard: false,
    },
    thresholds: {
      contextWarning: 70,
      contextCritical: 85,
    },
    staleTaskThresholdMinutes: 30,
    contextLimitWarning: {
      autoCompact: false,
      threshold: 90,
    },
    missionBoard: {
      enabled: false,
    },
    usageApiPollIntervalMs: 300000,
  } as const;
}

describe('HUD watch mode initialization', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let initializeHUDState: ReturnType<typeof vi.fn>;
  let readRalphStateForHud: ReturnType<typeof vi.fn>;
  let readUltraworkStateForHud: ReturnType<typeof vi.fn>;
  let readAutopilotStateForHud: ReturnType<typeof vi.fn>;
  let getUsage: ReturnType<typeof vi.fn>;
  let render: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  async function importHudModule(overrides: {
    config?: ReturnType<typeof makeConfig>;
    stdin?: ReturnType<typeof makeStdin>;
    getUsageResult?: unknown;
  } = {}) {
    vi.resetModules();
    const stdin = overrides.stdin ?? makeStdin();
    const config = overrides.config ?? makeConfig();

    initializeHUDState = vi.fn(async () => {});
    readRalphStateForHud = vi.fn(() => null);
    readUltraworkStateForHud = vi.fn(() => null);
    readAutopilotStateForHud = vi.fn(() => null);
    getUsage = vi.fn(async () => overrides.getUsageResult ?? null);
    render = vi.fn(async () => '[HUD] ok');

    vi.doMock('../../hud/stdin.js', () => ({
      readStdin: vi.fn(async () => null),
      writeStdinCache: vi.fn(),
      readStdinCache: vi.fn(() => stdin),
      getContextPercent: vi.fn(() => 12),
      getModelName: vi.fn(() => 'claude-test'),
      getRateLimitsFromStdin: vi.fn((value) => {
        const fiveHour = value.rate_limits?.five_hour?.used_percentage;
        const sevenDay = value.rate_limits?.seven_day?.used_percentage;
        if (fiveHour == null && sevenDay == null) {
          return null;
        }
        return {
          fiveHourPercent: fiveHour ?? 0,
          weeklyPercent: sevenDay,
          fiveHourResetsAt: fiveHour == null ? null : new Date(1776348000 * 1000),
          weeklyResetsAt: sevenDay == null ? null : new Date(1776916800 * 1000),
        };
      }),
      stabilizeContextPercent: vi.fn((value) => value),
    }));

    vi.doMock('../../hud/transcript.js', () => ({
      parseTranscript: vi.fn(async () => ({
        agents: [],
        todos: [],
        lastActivatedSkill: null,
        pendingPermission: null,
        thinkingState: null,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        sessionStart: null,
      })),
    }));

    vi.doMock('../../hud/state.js', () => ({
      initializeHUDState,
      readHudConfig: vi.fn(() => config),
      readHudState: vi.fn(() => null),
      getRunningTasks: vi.fn(() => []),
      writeHudState: vi.fn(() => true),
    }));

    vi.doMock('../../hud/omc-state.js', () => ({
      readRalphStateForHud,
      readUltraworkStateForHud,
      readPrdStateForHud: vi.fn(() => null),
      readAutopilotStateForHud,
    }));

    vi.doMock('../../hud/usage-api.js', () => ({ getUsage }));
    vi.doMock('../../hud/custom-rate-provider.js', () => ({ executeCustomProvider: vi.fn(async () => null) }));
    vi.doMock('../../hud/render.js', () => ({ render }));
    vi.doMock('../../hud/elements/api-key-source.js', () => ({ detectApiKeySource: vi.fn(() => null) }));
    vi.doMock('../../hud/mission-board.js', () => ({ refreshMissionBoardState: vi.fn(async () => null) }));
    vi.doMock('../../hud/sanitize.js', () => ({ sanitizeOutput: vi.fn((value: string) => value) }));
    vi.doMock('../../lib/version.js', () => ({ getRuntimePackageVersion: vi.fn(() => '4.7.9') }));
    vi.doMock('../../features/auto-update.js', () => ({ compareVersions: vi.fn(() => 0) }));
    vi.doMock('../../lib/worktree-paths.js', () => ({
      resolveToWorktreeRoot: vi.fn((cwd?: string) => cwd ?? '/tmp/worktree'),
      resolveTranscriptPath: vi.fn((transcriptPath?: string) => transcriptPath),
      getOmcRoot: vi.fn(() => '/tmp/worktree/.omc'),
    }));

    return import('../../hud/index.js');
  }

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock('../../hud/stdin.js');
    vi.doUnmock('../../hud/transcript.js');
    vi.doUnmock('../../hud/state.js');
    vi.doUnmock('../../hud/omc-state.js');
    vi.doUnmock('../../hud/usage-api.js');
    vi.doUnmock('../../hud/custom-rate-provider.js');
    vi.doUnmock('../../hud/render.js');
    vi.doUnmock('../../hud/elements/api-key-source.js');
    vi.doUnmock('../../hud/mission-board.js');
    vi.doUnmock('../../hud/sanitize.js');
    vi.doUnmock('../../lib/version.js');
    vi.doUnmock('../../features/auto-update.js');
    vi.doUnmock('../../lib/worktree-paths.js');
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    }
  });

  it('skips HUD initialization during watch polls after the first render', async () => {
    const hud = await importHudModule();
    initializeHUDState.mockClear();

    await hud.main(true, true);

    expect(initializeHUDState).not.toHaveBeenCalled();
  });

  it('still initializes HUD state for the first watch render', async () => {
    const hud = await importHudModule();
    initializeHUDState.mockClear();

    await hud.main(true, false);

    expect(initializeHUDState).toHaveBeenCalledTimes(1);
  });

  it('passes resolved cwd to initializeHUDState instead of defaulting to process.cwd()', async () => {
    const hud = await importHudModule();
    initializeHUDState.mockClear();

    await hud.main(true, false);

    // initializeHUDState must receive the resolved cwd from stdin, not undefined/process.cwd()
    expect(initializeHUDState).toHaveBeenCalledWith('/tmp/worktree', undefined);
  });

  it('passes the current session id to OMC state readers', async () => {
    const stdin = makeStdin();
    stdin.transcript_path = '/tmp/worktree/transcripts/123e4567-e89b-12d3-a456-426614174000.jsonl';
    const hud = await importHudModule({ stdin });

    await hud.main(true, false);

    expect(readRalphStateForHud).toHaveBeenCalledWith('/tmp/worktree', '123e4567-e89b-12d3-a456-426614174000');
    expect(readUltraworkStateForHud).toHaveBeenCalledWith('/tmp/worktree', '123e4567-e89b-12d3-a456-426614174000');
    expect(readAutopilotStateForHud).toHaveBeenCalledWith('/tmp/worktree', '123e4567-e89b-12d3-a456-426614174000');
  });

  it('prefers stdin rate limits over the usage API when available', async () => {
    const hud = await importHudModule({
      config: makeConfig(true),
      stdin: makeStdin(true),
    });

    await hud.main(true, false);

    expect(getUsage).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(expect.objectContaining({
      rateLimitsResult: {
        rateLimits: {
          fiveHourPercent: 11,
          weeklyPercent: 2,
          fiveHourResetsAt: new Date(1776348000 * 1000),
          weeklyResetsAt: new Date(1776916800 * 1000),
        },
      },
    }), expect.anything());
  });

  it('falls back to the usage API when stdin omits rate limits', async () => {
    const hud = await importHudModule({
      config: makeConfig(true),
      getUsageResult: { rateLimits: { fiveHourPercent: 55, weeklyPercent: 10 } },
    });

    await hud.main(true, false);

    expect(getUsage).toHaveBeenCalledTimes(1);
  });
});
