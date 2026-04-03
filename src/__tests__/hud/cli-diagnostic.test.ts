import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fakeConfig = {
  preset: 'focused',
  elements: {
    rateLimits: false,
    apiKeySource: false,
    safeMode: true,
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

describe('HUD CLI diagnostic (no stdin, no watch mode)', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let tempConfigDir: string;

  async function importHudModule(overrides: {
    readStdinCache?: () => unknown;
    configDir?: string;
    hudVersion?: string;
  } = {}) {
    vi.resetModules();

    vi.doMock('../../hud/stdin.js', () => ({
      readStdin: vi.fn(async () => null),
      writeStdinCache: vi.fn(),
      readStdinCache: vi.fn(overrides.readStdinCache ?? (() => null)),
      getContextPercent: vi.fn(() => 0),
      getModelName: vi.fn(() => 'unknown'),
      stabilizeContextPercent: vi.fn((_s: unknown) => _s),
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
      initializeHUDState: vi.fn(async () => {}),
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
    vi.doMock('../../lib/version.js', () => ({
      getRuntimePackageVersion: vi.fn(() => overrides.hudVersion ?? '4.10.1'),
    }));
    vi.doMock('../../features/auto-update.js', () => ({ compareVersions: vi.fn(() => 0) }));
    vi.doMock('../../lib/worktree-paths.js', () => ({
      resolveToWorktreeRoot: vi.fn((cwd?: string) => cwd ?? '/tmp'),
      resolveTranscriptPath: vi.fn((tp?: string) => tp),
      getOmcRoot: vi.fn(() => '/tmp/.omc'),
    }));
    vi.doMock('../../utils/paths.js', () => ({
      getClaudeConfigDir: vi.fn(() => overrides.configDir ?? tempConfigDir),
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

    // Create a temp config dir for each test
    tempConfigDir = join(tmpdir(), `omc-hud-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempConfigDir, 'hud'), { recursive: true });
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
    vi.doUnmock('../../utils/paths.js');
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    }
    try { rmSync(tempConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('shows diagnostic with version and preset when no stdin and no cache', async () => {
    const hud = await importHudModule();
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('[OMC] HUD v4.10.1');
    expect(output).toContain('preset: focused');
    expect(output).not.toContain('run /omc-setup to install properly');
  });

  it('shows HUD script as MISSING when omc-hud.mjs does not exist', async () => {
    const hud = await importHudModule();
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('HUD script:');
    expect(output).toContain('MISSING');
  });

  it('shows HUD script as installed when omc-hud.mjs exists', async () => {
    writeFileSync(join(tempConfigDir, 'hud', 'omc-hud.mjs'), '// stub');
    const hud = await importHudModule();
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('installed');
  });

  it('shows statusLine as configured when settings.json has omc-hud command', async () => {
    writeFileSync(join(tempConfigDir, 'hud', 'omc-hud.mjs'), '// stub');
    writeFileSync(
      join(tempConfigDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'node $HOME/.claude/hud/omc-hud.mjs' } }),
    );
    const hud = await importHudModule();
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('statusLine:');
    expect(output).toContain('configured');
    expect(output).toContain('HUD renders automatically inside Claude Code sessions.');
  });

  it('shows statusLine as NOT configured when settings.json has no statusLine', async () => {
    writeFileSync(join(tempConfigDir, 'settings.json'), JSON.stringify({}));
    const hud = await importHudModule();
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('NOT configured');
    expect(output).toContain('Run /oh-my-claudecode:hud setup to fix.');
  });

  it('handles legacy string statusLine format', async () => {
    writeFileSync(join(tempConfigDir, 'hud', 'omc-hud.mjs'), '// stub');
    writeFileSync(
      join(tempConfigDir, 'settings.json'),
      JSON.stringify({ statusLine: '~/.claude/hud/omc-hud.mjs' }),
    );
    const hud = await importHudModule();
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('configured');
  });

  it('shows correct version from getRuntimePackageVersion', async () => {
    const hud = await importHudModule({ hudVersion: '5.0.0' });
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('[OMC] HUD v5.0.0');
  });

  it('suggests setup fix when HUD script is missing', async () => {
    const hud = await importHudModule();
    await hud.main(false, false);

    const output = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Run /oh-my-claudecode:hud setup to fix.');
  });
});
