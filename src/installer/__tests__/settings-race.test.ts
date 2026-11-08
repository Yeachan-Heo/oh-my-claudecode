import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const raceState = vi.hoisted(() => ({
  settingsPath: null as string | null,
  triggerPath: null as string | null,
  injected: false,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');

  return {
    ...actual,
    writeFileSync: vi.fn((pathLike: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], options?: Parameters<typeof actual.writeFileSync>[2]) => {
      actual.writeFileSync(pathLike, data, options as never);

      const writtenPath = String(pathLike);
      if (
        raceState.settingsPath
        && raceState.triggerPath
        && !raceState.injected
        && writtenPath === raceState.triggerPath
      ) {
        const concurrentSettings = JSON.parse(actual.readFileSync(raceState.settingsPath, 'utf-8')) as Record<string, unknown>;
        concurrentSettings.contextCompression = true;
        concurrentSettings.concurrentPluginSetting = 'preserve-me';
        actual.writeFileSync(raceState.settingsPath, JSON.stringify(concurrentSettings, null, 2));
        raceState.injected = true;
      }
    }),
  };
});

const originalEnv = { ...process.env };

let tempRoot: string;
let homeDir: string;
let claudeConfigDir: string;
let codexHome: string;
let omcHome: string;

async function loadInstaller() {
  vi.resetModules();
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.HOME = homeDir;
  process.env.CODEX_HOME = codexHome;
  process.env.OMC_HOME = omcHome;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.OMC_PLUGIN_ROOT;
  return import('../index.js');
}

describe('install() settings.json lost-update protection (issue #2584)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'omc-settings-race-'));
    homeDir = join(tempRoot, 'home');
    claudeConfigDir = join(homeDir, '.claude');
    codexHome = join(tempRoot, '.codex');
    omcHome = join(tempRoot, '.omc');

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(claudeConfigDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(omcHome, { recursive: true });

    raceState.settingsPath = join(claudeConfigDir, 'settings.json');
    raceState.triggerPath = join(omcHome, 'mcp-registry.json');
    raceState.injected = false;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    raceState.settingsPath = null;
    raceState.triggerPath = null;
    raceState.injected = false;
    rmSync(tempRoot, { recursive: true, force: true });
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('preserves concurrent disjoint settings updates while still applying installer-managed changes', async () => {
    writeFileSync(raceState.settingsPath!, JSON.stringify({
      theme: 'dark',
      mcpServers: {
        gitnexus: {
          command: 'gitnexus',
          args: ['mcp'],
        },
      },
    }, null, 2));

    const installer = await loadInstaller();
    const result = installer.install({
      skipClaudeCheck: true,
      skipHud: true,
    });

    const writtenSettings = JSON.parse(readFileSync(raceState.settingsPath!, 'utf-8')) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(raceState.injected).toBe(true);
    expect(writtenSettings.theme).toBe('dark');
    expect(writtenSettings.contextCompression).toBe(true);
    expect(writtenSettings.concurrentPluginSetting).toBe('preserve-me');
    expect(writtenSettings).not.toHaveProperty('mcpServers');
    expect(writtenSettings).toHaveProperty('hooks');
  });
});
