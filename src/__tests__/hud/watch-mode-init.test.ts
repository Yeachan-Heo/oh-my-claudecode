import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fakeStdin = {
  cwd: '/tmp/worktree',
  transcript_path: '/tmp/worktree/transcript.jsonl',
  model: { id: 'claude-test' },
  context_window: {
    used_percentage: 12,
    current_usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    context_window_size: 100,
  },
};

const fakeConfig = {
  preset: 'focused',
  elements: {
    rateLimits: false,
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

describe('HUD watch mode initialization', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let initializeHUDState: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  async function importHudModule() {
    vi.resetModules();

    initializeHUDState = vi.fn(async () => {});

    vi.doMock('../../hud/stdin.js', () => ({
      readStdin: vi.fn(async () => null),
      writeStdinCache: vi.fn(),
      readStdinCache: vi.fn(() => fakeStdin),
      getContextPercent: vi.fn(() => 12),
      getModelName: vi.fn(() => 'claude-test'),
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
      readHudConfig: vi.fn(() => fakeConfig),
      readHudState: vi.fn(() => null),
      getRunningTasks: vi.fn(() => []),
      writeHudState: vi.fn(() => true),
    }));

    vi.doMock('../../hud/omc-state.js', () => ({
      readRalphStateForHud: vi.fn(() => null),
      readUltraworkStateForHud: vi.fn(() => null),
      readPrdStateForHud: vi.fn(() => null),
      readAutopilotStateForHud: vi.fn(() => null),
    }));

    vi.doMock('../../hud/usage-api.js', () => ({ getUsage: vi.fn(async () => null) }));
    vi.doMock('../../hud/custom-rate-provider.js', () => ({ executeCustomProvider: vi.fn(async () => null) }));
    vi.doMock('../../hud/render.js', () => ({ render: vi.fn(async () => '[HUD] ok') }));
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
});
