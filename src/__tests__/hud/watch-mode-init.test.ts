import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

function makeStdin(
  withRateLimits = false,
  rateLimitOverrides: Partial<{
    fiveHourPercent: number | null;
    weeklyPercent: number | null;
    fiveHourResetAt: number | null;
    weeklyResetAt: number | null;
  }> = {},
) {
  const fiveHourPercent = 'fiveHourPercent' in rateLimitOverrides ? rateLimitOverrides.fiveHourPercent : 11;
  const weeklyPercent = 'weeklyPercent' in rateLimitOverrides ? rateLimitOverrides.weeklyPercent : 2;
  const fiveHourResetAt = 'fiveHourResetAt' in rateLimitOverrides ? rateLimitOverrides.fiveHourResetAt : 1776348000;
  const weeklyResetAt = 'weeklyResetAt' in rateLimitOverrides ? rateLimitOverrides.weeklyResetAt : 1776916800;

  return {
    cwd: '/tmp/worktree',
    transcript_path: '/tmp/worktree/transcript.jsonl',
    model: { id: 'claude-test' },
    context_window: {
      used_percentage: 12,
      current_usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      context_window_size: 100,
    },
    ...(withRateLimits
      ? {
          rate_limits: {
            five_hour: {
              used_percentage: fiveHourPercent,
              resets_at: fiveHourResetAt,
            },
            seven_day: {
              used_percentage: weeklyPercent,
              resets_at: weeklyResetAt,
            },
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
  let readAutopilotStateForHud: ReturnType<typeof vi.fn>;
  let getUsage: ReturnType<typeof vi.fn>;
  let render: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  async function importHudModule(
    overrides: {
      config?: ReturnType<typeof makeConfig>;
      stdin?: ReturnType<typeof makeStdin>;
      getUsageResult?: unknown;
    } = {},
  ) {
    vi.resetModules();
    const stdin = overrides.stdin ?? makeStdin();
    const config = overrides.config ?? makeConfig();

    initializeHUDState = vi.fn(async () => {});
    readRalphStateForHud = vi.fn(() => null);
    readAutopilotStateForHud = vi.fn(() => null);
    getUsage = vi.fn(async () => overrides.getUsageResult ?? null);
    render = vi.fn(async () => '[HUD] ok');

    vi.doMock('../../hud/stdin.js', () => ({
      readStdin: vi.fn(async () => null),
      writeStdinCache: vi.fn(),
      readStdinCache: vi.fn(() => stdin),
      getContextPercent: vi.fn(() => 12),
      getModelId: vi.fn(() => 'claude-test'),
      getModelName: vi.fn(() => 'claude-test'),
      getRateLimitsFromStdin: vi.fn((value) => {
        const fiveHour = value.rate_limits?.five_hour?.used_percentage;
        const sevenDay = value.rate_limits?.seven_day?.used_percentage;
        const rateLimits: {
          fiveHourPercent?: number;
          weeklyPercent?: number;
          fiveHourResetsAt?: Date | null;
          weeklyResetsAt?: Date | null;
        } = {};
        if (fiveHour != null) {
          rateLimits.fiveHourPercent = fiveHour;
          const resetsAt = value.rate_limits?.five_hour?.resets_at;
          rateLimits.fiveHourResetsAt = resetsAt == null ? null : new Date(resetsAt * 1000);
        }
        if (sevenDay != null) {
          rateLimits.weeklyPercent = sevenDay;
          const resetsAt = value.rate_limits?.seven_day?.resets_at;
          rateLimits.weeklyResetsAt = resetsAt == null ? null : new Date(resetsAt * 1000);
        }
        return Object.keys(rateLimits).length > 0 ? rateLimits : null;
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
      readPrdStateForHud: vi.fn(() => null),
      readAutopilotStateForHud,
    }));

    vi.doMock('../../hud/usage-api.js', () => ({
      getUsage,
      getSubscriptionInfo: vi.fn(() => ({
        subscriptionType: null,
        rateLimitTier: null,
      })),
    }));
    vi.doMock('../../hud/custom-rate-provider.js', () => ({
      executeCustomProvider: vi.fn(async () => null),
    }));
    vi.doMock('../../hud/render.js', () => ({ render }));
    vi.doMock('../../hud/elements/api-key-source.js', () => ({
      detectApiKeySource: vi.fn(() => null),
    }));
    vi.doMock('../../hud/mission-board.js', () => ({
      refreshMissionBoardState: vi.fn(async () => null),
    }));
    vi.doMock('../../hud/sanitize.js', () => ({
      sanitizeOutput: vi.fn((value: string) => value),
    }));
    vi.doMock('../../lib/version.js', () => ({
      getRuntimePackageVersion: vi.fn(() => '4.7.9'),
    }));
    vi.doMock('../../features/auto-update.js', () => ({
      compareVersions: vi.fn(() => 0),
    }));
    vi.doMock('../../lib/worktree-paths.js', () => ({
      resolveToWorktreeRoot: vi.fn((cwd?: string) => cwd ?? '/tmp/worktree'),
      resolveTranscriptPath: vi.fn((transcriptPath?: string) => transcriptPath),
      getOmcRoot: vi.fn(() => '/tmp/worktree/.omc'),
      withWorktreePathRenderScope: vi.fn((callback: () => unknown) => callback()),
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
    expect(readAutopilotStateForHud).toHaveBeenCalledWith('/tmp/worktree', '123e4567-e89b-12d3-a456-426614174000');
  });

  it('merges stdin generic rate limits over usage API data when available', async () => {
    const hud = await importHudModule({
      config: makeConfig(true),
      stdin: makeStdin(true),
      getUsageResult: {
        rateLimits: {
          fiveHourPercent: 55,
          weeklyPercent: 10,
          fiveHourResetsAt: new Date((1776348000 - 5 * 60 * 60) * 1000),
          weeklyResetsAt: new Date((1776916800 - 7 * 24 * 60 * 60) * 1000),
          sonnetWeeklyPercent: 44,
          sonnetWeeklyResetsAt: new Date(1777200000 * 1000),
          opusWeeklyPercent: 7,
          opusWeeklyResetsAt: new Date(1777300000 * 1000),
          extraUsagePercent: 3,
          extraUsageSpentUsd: 1.25,
          extraUsageLimitUsd: 10,
        },
        error: 'network',
        stale: true,
      },
    });

    await hud.main(true, false);

    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitsResult: {
          rateLimits: {
            fiveHourPercent: 11,
            weeklyPercent: 2,
            fiveHourResetsAt: new Date(1776348000 * 1000),
            weeklyResetsAt: new Date(1776916800 * 1000),
            sonnetWeeklyPercent: 44,
            sonnetWeeklyResetsAt: new Date(1777200000 * 1000),
            opusWeeklyPercent: 7,
            opusWeeklyResetsAt: new Date(1777300000 * 1000),
            extraUsagePercent: 3,
            extraUsageSpentUsd: 1.25,
            extraUsageLimitUsd: 10,
          },
          error: 'network',
          stale: true,
        },
      }),
      expect.anything(),
    );
  });

  it('falls back to stdin rate limits when usage API returns no rate limits', async () => {
    const hud = await importHudModule({
      config: makeConfig(true),
      stdin: makeStdin(true),
      getUsageResult: { rateLimits: null, error: 'no_credentials' },
    });

    await hud.main(true, false);

    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitsResult: {
          rateLimits: {
            fiveHourPercent: 11,
            weeklyPercent: 2,
            fiveHourResetsAt: new Date(1776348000 * 1000),
            weeklyResetsAt: new Date(1776916800 * 1000),
          },
          error: 'no_credentials',
        },
      }),
      expect.anything(),
    );
  });

  it.each([-60_000, 60_000])(
    'uses the higher usage API percentage at the exact %s ms window boundary for stale results',
    async (resetDeltaMs) => {
      const hud = await importHudModule({
        config: makeConfig(true),
        stdin: makeStdin(true),
        getUsageResult: {
          rateLimits: {
            fiveHourPercent: 41,
            weeklyPercent: 1,
            // Exactly 60 seconds remains inside the same-window tolerance.
            fiveHourResetsAt: new Date(1776348000 * 1000 + resetDeltaMs),
            weeklyResetsAt: new Date(1776916800 * 1000),
          },
          error: 'network',
          stale: true,
        },
      });

      await hud.main(true, false);

      expect(render).toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimitsResult: {
            rateLimits: {
              fiveHourPercent: 41,
              weeklyPercent: 2,
              fiveHourResetsAt: new Date(1776348000 * 1000),
              weeklyResetsAt: new Date(1776916800 * 1000),
            },
            error: 'network',
            stale: true,
          },
        }),
        expect.anything(),
      );
    },
  );

  it('keeps stdin values when the usage API is still on the previous window', async () => {
    const hud = await importHudModule({
      config: makeConfig(true),
      stdin: makeStdin(true),
      getUsageResult: {
        rateLimits: {
          fiveHourPercent: 90,
          weeklyPercent: 85,
          fiveHourResetsAt: new Date((1776348000 - 5 * 60 * 60) * 1000),
          weeklyResetsAt: new Date((1776916800 - 7 * 24 * 60 * 60) * 1000),
        },
      },
    });

    await hud.main(true, false);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitsResult: {
          rateLimits: {
            fiveHourPercent: 11,
            weeklyPercent: 2,
            fiveHourResetsAt: new Date(1776348000 * 1000),
            weeklyResetsAt: new Date(1776916800 * 1000),
          },
        },
      }),
      expect.anything(),
    );
  });

  it('keeps stdin values when its reset timestamps are older than the API window', async () => {
    const hud = await importHudModule({
      config: makeConfig(true),
      stdin: makeStdin(true, {
        fiveHourResetAt: 1776348000 - 5 * 60 * 60,
        weeklyResetAt: 1776916800 - 7 * 24 * 60 * 60,
      }),
      getUsageResult: {
        rateLimits: {
          fiveHourPercent: 3,
          weeklyPercent: 1,
          fiveHourResetsAt: new Date(1776348000 * 1000),
          weeklyResetsAt: new Date(1776916800 * 1000),
        },
      },
    });

    await hud.main(true, false);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitsResult: {
          rateLimits: {
            fiveHourPercent: 11,
            weeklyPercent: 2,
            fiveHourResetsAt: new Date((1776348000 - 5 * 60 * 60) * 1000),
            weeklyResetsAt: new Date((1776916800 - 7 * 24 * 60 * 60) * 1000),
          },
        },
      }),
      expect.anything(),
    );
  });

  it.each([undefined, null])(
    'preserves API buckets when stdin percentage is %s and falls back when API reset is null',
    async (fiveHourPercent) => {
      const hud = await importHudModule({
        config: makeConfig(true),
        stdin: makeStdin(true, { fiveHourPercent }),
        getUsageResult: {
          rateLimits: {
            fiveHourPercent: 88,
            fiveHourResetsAt: new Date(1776348000 * 1000),
            weeklyPercent: 99,
            weeklyResetsAt: null,
            sonnetWeeklyPercent: 44,
            opusWeeklyPercent: 7,
            extraUsagePercent: 3,
          },
        },
      });

      await hud.main(true, false);

      expect(render).toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimitsResult: {
            rateLimits: {
              fiveHourPercent: 88,
              fiveHourResetsAt: new Date(1776348000 * 1000),
              weeklyPercent: 2,
              weeklyResetsAt: new Date(1776916800 * 1000),
              sonnetWeeklyPercent: 44,
              opusWeeklyPercent: 7,
              extraUsagePercent: 3,
            },
          },
        }),
        expect.anything(),
      );
    },
  );

  it('falls back to the usage API when stdin omits rate limits', async () => {
    const hud = await importHudModule({
      config: makeConfig(true),
      getUsageResult: {
        rateLimits: { fiveHourPercent: 55, weeklyPercent: 10 },
      },
    });

    await hud.main(true, false);

    expect(getUsage).toHaveBeenCalledTimes(1);
  });
});
