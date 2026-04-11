/**
 * Tests for src/setup/phases/phase3-integrations.ts
 *
 * Phase 3 handles plugin verification, MCP install, and teams config.
 * Tests stub `installMcpServers` + config-writer helpers via DI and use
 * a tmpdir for the settings.json grep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../options.js';
import { runPhase3 } from '../phases/phase3-integrations.js';
import { makeOptions } from './test-helpers.js';

describe('runPhase3', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'phase3-test-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('reports plugin verified when settings.json mentions oh-my-claudecode', async () => {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ plugins: { 'oh-my-claudecode': { enabled: true } } }),
      'utf8',
    );

    const lines: string[] = [];
    const result = await runPhase3(
      makeOptions(),
      (line) => lines.push(line),
      {
        configDir,
        installMcpServers: vi.fn(),
        mergeOmcConfig: vi.fn(),
        mergeSettingsJson: vi.fn(),
      },
    );

    expect(result.pluginVerified).toBe(true);
    expect(lines).toContain('Plugin verified');
  });

  it('reports plugin NOT found when settings.json is missing', async () => {
    const lines: string[] = [];
    const result = await runPhase3(makeOptions(), (line) => lines.push(line), {
      configDir,
      installMcpServers: vi.fn(),
      mergeOmcConfig: vi.fn(),
      mergeSettingsJson: vi.fn(),
    });

    expect(result.pluginVerified).toBe(false);
    expect(lines).toContain('Plugin NOT found - run: claude /install-plugin oh-my-claudecode');
  });

  it('reports plugin NOT found when settings.json lacks the marker string', async () => {
    writeFileSync(join(configDir, 'settings.json'), '{"foo":"bar"}', 'utf8');

    const lines: string[] = [];
    const result = await runPhase3(makeOptions(), (line) => lines.push(line), {
      configDir,
      installMcpServers: vi.fn(),
      mergeOmcConfig: vi.fn(),
      mergeSettingsJson: vi.fn(),
    });

    expect(result.pluginVerified).toBe(false);
    expect(lines).toContain('Plugin NOT found - run: claude /install-plugin oh-my-claudecode');
  });

  it('skips MCP install when mcp.enabled is false', async () => {
    const installMcp = vi.fn();
    const result = await runPhase3(
      makeOptions({ mcp: { ...DEFAULTS.mcp, enabled: false, credentials: {}, servers: [] } }),
      () => { /* silent */ },
      {
        configDir,
        installMcpServers: installMcp,
        mergeOmcConfig: vi.fn(),
        mergeSettingsJson: vi.fn(),
      },
    );

    expect(installMcp).not.toHaveBeenCalled();
    expect(result.mcpInstalled).toEqual([]);
    expect(result.mcpSkipped).toEqual([]);
  });

  it('calls installMcpServers with scope=user when mcp.enabled=true', async () => {
    const installMcp = vi.fn().mockResolvedValue({
      installed: ['context7', 'exa'],
      skippedDueToMissingCreds: ['github'],
      failed: [],
    });

    const lines: string[] = [];
    const result = await runPhase3(
      makeOptions({
        interactive: false,
        mcp: {
          enabled: true,
          servers: ['context7', 'exa', 'github'],
          credentials: { exa: 'sk-test' },
          onMissingCredentials: 'skip',
          scope: 'user',
        },
      }),
      (line) => lines.push(line),
      {
        configDir,
        installMcpServers: installMcp,
        mergeOmcConfig: vi.fn(),
        mergeSettingsJson: vi.fn(),
      },
    );

    expect(installMcp).toHaveBeenCalledOnce();
    const [servers, creds, opts] = installMcp.mock.calls[0];
    expect(servers).toEqual(['context7', 'exa', 'github']);
    expect(creds).toEqual({ exa: 'sk-test' });
    expect(opts.scope).toBe('user');
    expect(opts.interactive).toBe(false);
    expect(opts.onMissingCredentials).toBe('skip');

    expect(result.mcpInstalled).toEqual(['context7', 'exa']);
    expect(result.mcpSkipped).toEqual(['github']);
    expect(lines).toContain('Installed MCP servers: context7, exa');
    expect(lines).toContain('Skipped MCP servers (missing credentials): github');
  });

  it('skips all teams writes when teams.enabled=false', async () => {
    const mergeOmc = vi.fn();
    const mergeSettings = vi.fn();

    const result = await runPhase3(makeOptions(), () => { /* silent */ }, {
      configDir,
      installMcpServers: vi.fn(),
      mergeOmcConfig: mergeOmc,
      mergeSettingsJson: mergeSettings,
    });

    expect(mergeOmc).not.toHaveBeenCalled();
    expect(mergeSettings).not.toHaveBeenCalled();
    expect(result.teamsConfigured).toBe(false);
  });

  it('writes env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS and team config when teams.enabled=true', async () => {
    const mergeOmc = vi.fn();
    const mergeSettings = vi.fn();

    const lines: string[] = [];
    const result = await runPhase3(
      makeOptions({
        teams: {
          enabled: true,
          displayMode: 'auto',
          agentCount: 5,
          agentType: 'executor',
        },
      }),
      (line) => lines.push(line),
      {
        configDir,
        installMcpServers: vi.fn(),
        mergeOmcConfig: mergeOmc,
        mergeSettingsJson: mergeSettings,
      },
    );

    expect(result.teamsConfigured).toBe(true);
    expect(lines).toContain('Enabled agent teams (experimental)');

    // settings.json patch: env var only (displayMode=auto → no teammateMode)
    expect(mergeSettings).toHaveBeenCalledOnce();
    const [settingsPatch] = mergeSettings.mock.calls[0];
    expect(settingsPatch).toEqual({
      env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    });
    expect(settingsPatch).not.toHaveProperty('teammateMode');

    // .omc-config.json patch: team config
    expect(mergeOmc).toHaveBeenCalledOnce();
    const [omcPatch] = mergeOmc.mock.calls[0];
    expect(omcPatch).toEqual({
      team: {
        maxAgents: 5,
        defaultAgentType: 'executor',
        monitorIntervalMs: 30000,
        shutdownTimeoutMs: 15000,
      },
    });
  });

  it('writes teammateMode into settings.json when displayMode != auto', async () => {
    const mergeSettings = vi.fn();

    await runPhase3(
      makeOptions({
        teams: {
          enabled: true,
          displayMode: 'tmux',
          agentCount: 3,
          agentType: 'debugger',
        },
      }),
      () => { /* silent */ },
      {
        configDir,
        installMcpServers: vi.fn(),
        mergeOmcConfig: vi.fn(),
        mergeSettingsJson: mergeSettings,
      },
    );

    const [settingsPatch] = mergeSettings.mock.calls[0];
    expect(settingsPatch['teammateMode']).toBe('tmux');
    expect((settingsPatch['env'] as Record<string, string>)['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']).toBe('1');
  });

  it('passes through options.interactive to installMcpServers', async () => {
    const installMcp = vi.fn().mockResolvedValue({ installed: [], skippedDueToMissingCreds: [], failed: [] });

    await runPhase3(
      makeOptions({
        interactive: true,
        mcp: {
          enabled: true,
          servers: ['context7'],
          credentials: {},
          onMissingCredentials: 'error',
          scope: 'user',
        },
      }),
      () => { /* silent */ },
      {
        configDir,
        installMcpServers: installMcp,
        mergeOmcConfig: vi.fn(),
        mergeSettingsJson: vi.fn(),
      },
    );

    const [, , opts] = installMcp.mock.calls[0];
    expect(opts.interactive).toBe(true);
    expect(opts.onMissingCredentials).toBe('error');
  });

  it('treats unreadable settings.json as "not verified" rather than throwing', async () => {
    // Create a directory at settings.json path — readFileSync will throw EISDIR.
    mkdirSync(join(configDir, 'settings.json'));

    const lines: string[] = [];
    const result = await runPhase3(makeOptions(), (line) => lines.push(line), {
      configDir,
      installMcpServers: vi.fn(),
      mergeOmcConfig: vi.fn(),
      mergeSettingsJson: vi.fn(),
    });

    expect(result.pluginVerified).toBe(false);
    expect(lines).toContain('Plugin NOT found - run: claude /install-plugin oh-my-claudecode');
  });
});
