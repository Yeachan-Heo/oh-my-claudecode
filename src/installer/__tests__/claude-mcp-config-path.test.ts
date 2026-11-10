import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve, sep } from 'path';

import {
  getClaudeMcpConfigPath,
  getCodexConfigPath,
  getUnifiedMcpRegistryPath,
  inspectUnifiedMcpRegistrySync,
  syncUnifiedMcpRegistryTargets,
} from '../mcp-registry.js';

// Claude Code reads user-scoped MCP servers from
// join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json'): ~/.claude.json by
// default, and the .claude.json inside the profile when CLAUDE_CONFIG_DIR is set.
// A CLAUDE_CONFIG_DIR that resolves to ~/.claude counts as unset, as in `omc launch`.
//
// homedir() reads the real environment (USERPROFILE on Windows, HOME elsewhere),
// so these tests set and restore variables on process.env itself. Replacing the
// process.env object would leave homedir() on the real home.
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_MCP_CONFIG_PATH',
  'OMC_MCP_REGISTRY_PATH',
  'CODEX_HOME',
  'OMC_HOME',
] as const;

describe('Claude MCP config path follows CLAUDE_CONFIG_DIR', () => {
  let testRoot: string;
  // The user's home: a profile at <homeDir>/.claude-work sits next to
  // <homeDir>/.claude.json, the default profile's file.
  let homeDir: string;
  const savedEnv = new Map<string, string | undefined>();

  const writeJson = (path: string, value: unknown): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
  };
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf-8'));

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    testRoot = mkdtempSync(join(tmpdir(), 'omc-mcp-config-path-'));
    homeDir = join(testRoot, 'home');
    mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.CODEX_HOME = join(testRoot, '.codex');
    process.env.OMC_HOME = join(testRoot, '.omc');
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_MCP_CONFIG_PATH;
    delete process.env.OMC_MCP_REGISTRY_PATH;
    expect(homedir()).toBe(homeDir);
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('uses ~/.claude.json when CLAUDE_CONFIG_DIR is unset', () => {
    expect(getClaudeMcpConfigPath()).toBe(join(homeDir, '.claude.json'));
  });

  it('uses the .claude.json inside CLAUDE_CONFIG_DIR when it names a profile', () => {
    const profileDir = join(testRoot, 'profiles', 'work');
    process.env.CLAUDE_CONFIG_DIR = profileDir;
    expect(getClaudeMcpConfigPath()).toBe(join(profileDir, '.claude.json'));
  });

  it('uses ~/.claude.json when CLAUDE_CONFIG_DIR resolves to the default ~/.claude', () => {
    // `omc launch` unsets CLAUDE_CONFIG_DIR for this dir, so its sessions read ~/.claude.json.
    const defaultConfigDir = join(homeDir, '.claude');
    for (const configured of [defaultConfigDir, `${defaultConfigDir}${sep}`, '~/.claude']) {
      process.env.CLAUDE_CONFIG_DIR = configured;
      expect(getClaudeMcpConfigPath()).toBe(join(homeDir, '.claude.json'));
    }
  });

  it('still lets CLAUDE_MCP_CONFIG_PATH override the path', () => {
    process.env.CLAUDE_CONFIG_DIR = join(testRoot, 'profiles', 'work');
    process.env.CLAUDE_MCP_CONFIG_PATH = join(testRoot, 'custom', 'claude.json');
    expect(getClaudeMcpConfigPath()).toBe(join(testRoot, 'custom', 'claude.json'));
  });

  it('applies the same rule to a config dir passed in, as omc launch does', () => {
    const profileDir = join(testRoot, 'profiles', 'work');
    expect(getClaudeMcpConfigPath(profileDir)).toBe(join(profileDir, '.claude.json'));
    expect(getClaudeMcpConfigPath(join(homeDir, '.claude'))).toBe(join(homeDir, '.claude.json'));

    process.env.CLAUDE_MCP_CONFIG_PATH = ` ${join(testRoot, 'custom', 'claude.json')} `;
    expect(getClaudeMcpConfigPath(profileDir)).toBe(join(testRoot, 'custom', 'claude.json'));
  });

  it('syncs registry servers into the profile .claude.json and leaves ~/.claude.json unchanged', () => {
    const profileDir = join(homeDir, '.claude-work');
    const profileConfigPath = join(profileDir, '.claude.json');
    const defaultConfigPath = join(homeDir, '.claude.json');
    process.env.CLAUDE_CONFIG_DIR = profileDir;

    const defaultConfig = { mcpServers: { 'personal-notes': { command: 'node', args: ['-e', '1'] } } };
    writeJson(defaultConfigPath, defaultConfig);
    writeJson(profileConfigPath, {
      numStartups: 3,
      mcpServers: { 'work-docs': { command: 'node', args: ['-e', '0'] } },
    });
    writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': { command: 'node', args: ['-e', '2'] } });

    const { result } = syncUnifiedMcpRegistryTargets({});

    expect(result.claudeConfigPath).toBe(profileConfigPath);
    expect(result.claudeChanged).toBe(true);
    expect(readJson(profileConfigPath)).toEqual({
      numStartups: 3,
      mcpServers: {
        'work-docs': { command: 'node', args: ['-e', '0'] },
        'team-docs': { command: 'node', args: ['-e', '2'] },
      },
    });
    expect(readJson(defaultConfigPath)).toEqual(defaultConfig);

    const status = inspectUnifiedMcpRegistrySync();
    expect(status.claudeConfigPath).toBe(profileConfigPath);
    expect(status.claudeMissing).toEqual([]);
    expect(status.claudeMismatched).toEqual([]);
  });

  it('reports a registry server missing from the profile even when ~/.claude.json has it', () => {
    const profileDir = join(homeDir, '.claude-work');
    const teamDocs = { command: 'node', args: ['-e', '2'] };
    process.env.CLAUDE_CONFIG_DIR = profileDir;
    writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });
    writeJson(join(homeDir, '.claude.json'), { mcpServers: { 'team-docs': teamDocs } });
    writeJson(join(profileDir, '.claude.json'), { mcpServers: {} });

    const status = inspectUnifiedMcpRegistrySync();

    expect(status.claudeConfigPath).toBe(join(profileDir, '.claude.json'));
    expect(status.claudeMissing).toEqual(['team-docs']);
  });

  it('bootstraps the registry from the profile servers, not from ~/.claude.json', () => {
    const profileDir = join(homeDir, '.claude-work');
    process.env.CLAUDE_CONFIG_DIR = profileDir;
    writeJson(join(homeDir, '.claude.json'), {
      mcpServers: { 'personal-notes': { command: 'node', args: ['-e', '1'] } },
    });
    writeJson(join(profileDir, '.claude.json'), {
      mcpServers: { 'work-docs': { command: 'node', args: ['-e', '0'] } },
    });

    const { result } = syncUnifiedMcpRegistryTargets({});

    expect(result.bootstrappedFromClaude).toBe(true);
    expect(result.serverNames).toEqual(['work-docs']);
    expect(readJson(getUnifiedMcpRegistryPath())).toEqual({
      'work-docs': { command: 'node', args: ['-e', '0'] },
    });
    const codexConfig = readFileSync(getCodexConfigPath(), 'utf-8');
    expect(codexConfig).toContain('[mcp_servers.work-docs]');
    expect(codexConfig).not.toContain('personal-notes');
  });

  describe('servers removed from the registry', () => {
    // A sync records the registry names it wrote into the Claude MCP config and
    // removes them on a later sync once they leave the registry. Those names
    // belong to the file they were written into.
    const teamDocs = { command: 'node', args: ['-e', '2'] };
    const syncedDatabase = { command: 'node', args: ['-e', '3'] };
    const ownDatabase = { command: 'node', args: ['-e', '9'] };
    const statePath = (): string => join(testRoot, '.omc', 'state', 'mcp-registry-state.json');

    it('keeps a profile server named in a state from an older sync of the file next to the profile', () => {
      // An older OMC synced the registry into <profiles>/.claude.json and recorded
      // the names without a path. `database` has since left the registry, and the
      // profile has a `database` server of its own.
      const profileDir = join(testRoot, 'profiles', 'work');
      const profileConfigPath = join(profileDir, '.claude.json');
      const siblingConfigPath = join(testRoot, 'profiles', '.claude.json');
      const siblingConfig = { mcpServers: { database: syncedDatabase, 'team-docs': teamDocs } };
      process.env.CLAUDE_CONFIG_DIR = profileDir;
      writeJson(siblingConfigPath, siblingConfig);
      writeJson(statePath(), { managedServers: ['database', 'team-docs'] });
      writeJson(profileConfigPath, { mcpServers: { database: ownDatabase } });
      writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });

      syncUnifiedMcpRegistryTargets({});

      expect(readJson(profileConfigPath)).toEqual({
        mcpServers: { database: ownDatabase, 'team-docs': teamDocs },
      });
      expect(readJson(siblingConfigPath)).toEqual(siblingConfig);
      // The profile has a `database`, so the name is not recorded for the file next
      // to the profile either: the state does not say which of the two files it was
      // synced into.
      expect(readJson(statePath())).toEqual({
        managedServers: ['team-docs'],
        managedServersByClaudeConfig: {
          [resolve(siblingConfigPath)]: ['team-docs'],
          [resolve(profileConfigPath)]: ['team-docs'],
        },
      });
    });

    it('keeps a profile server that has the name of a server synced into another file', () => {
      const defaultConfigPath = join(homeDir, '.claude.json');
      const profileDir = join(homeDir, '.claude-work');
      const profileConfigPath = join(profileDir, '.claude.json');
      writeJson(getUnifiedMcpRegistryPath(), { database: syncedDatabase, 'team-docs': teamDocs });
      syncUnifiedMcpRegistryTargets({});
      expect(readJson(statePath())).toEqual({
        managedServers: ['database', 'team-docs'],
        managedServersByClaudeConfig: { [resolve(defaultConfigPath)]: ['database', 'team-docs'] },
      });

      // `database` leaves the registry, and the next sync is for a profile with
      // a `database` server of its own.
      writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });
      writeJson(profileConfigPath, { mcpServers: { database: ownDatabase } });
      process.env.CLAUDE_CONFIG_DIR = profileDir;
      syncUnifiedMcpRegistryTargets({});

      expect(readJson(profileConfigPath)).toEqual({
        mcpServers: { database: ownDatabase, 'team-docs': teamDocs },
      });
      expect(readJson(defaultConfigPath)).toEqual({
        mcpServers: { database: syncedDatabase, 'team-docs': teamDocs },
      });
    });

    it('removes a server that left the registry from each file it was synced into', () => {
      // Syncs for the default ~/.claude and for a profile share one state file.
      const defaultConfigPath = join(homeDir, '.claude.json');
      const profileDir = join(homeDir, '.claude-work');
      const profileConfigPath = join(profileDir, '.claude.json');
      const workDocs = { command: 'node', args: ['-e', '0'] };
      const syncDefault = (): void => {
        delete process.env.CLAUDE_CONFIG_DIR;
        syncUnifiedMcpRegistryTargets({});
      };
      const syncProfile = (): void => {
        process.env.CLAUDE_CONFIG_DIR = profileDir;
        syncUnifiedMcpRegistryTargets({});
      };
      writeJson(profileConfigPath, { mcpServers: { 'work-docs': workDocs } });
      writeJson(getUnifiedMcpRegistryPath(), { database: syncedDatabase, 'team-docs': teamDocs });
      syncDefault();
      syncProfile();
      expect(readJson(statePath())).toEqual({
        managedServers: ['database', 'team-docs'],
        managedServersByClaudeConfig: {
          [resolve(defaultConfigPath)]: ['database', 'team-docs'],
          [resolve(profileConfigPath)]: ['database', 'team-docs'],
        },
      });

      writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });
      syncDefault();
      expect(readJson(defaultConfigPath)).toEqual({ mcpServers: { 'team-docs': teamDocs } });
      syncProfile();
      expect(readJson(profileConfigPath)).toEqual({
        mcpServers: { 'work-docs': workDocs, 'team-docs': teamDocs },
      });
    });

    it('still removes a server that left the registry from ~/.claude.json, given a state from an older sync', () => {
      // For the default ~/.claude, an older OMC synced into the same ~/.claude.json.
      const defaultConfigPath = join(homeDir, '.claude.json');
      const personalNotes = { command: 'node', args: ['-e', '1'] };
      for (const configured of [undefined, join(homeDir, '.claude')]) {
        if (configured === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = configured;
        }
        writeJson(defaultConfigPath, {
          mcpServers: { database: syncedDatabase, 'personal-notes': personalNotes, 'team-docs': teamDocs },
        });
        writeJson(statePath(), { managedServers: ['database', 'team-docs'] });
        writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });

        syncUnifiedMcpRegistryTargets({});

        expect(readJson(defaultConfigPath)).toEqual({
          mcpServers: { 'personal-notes': personalNotes, 'team-docs': teamDocs },
        });
      }
    });

    it('keeps the names of a state from an older sync for its file when another file is synced first', () => {
      // An older OMC synced a profile under home into ~/.claude.json, the file next
      // to it, and `database` has since left the registry. The first sync after the
      // update is for the profile; a later sync for the default ~/.claude still
      // removes `database` from ~/.claude.json.
      const defaultConfigPath = join(homeDir, '.claude.json');
      const personalNotes = { command: 'node', args: ['-e', '1'] };
      writeJson(defaultConfigPath, {
        mcpServers: { database: syncedDatabase, 'personal-notes': personalNotes, 'team-docs': teamDocs },
      });
      writeJson(statePath(), { managedServers: ['database', 'team-docs'] });
      writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });

      process.env.CLAUDE_CONFIG_DIR = join(homeDir, '.claude-work');
      syncUnifiedMcpRegistryTargets({});
      delete process.env.CLAUDE_CONFIG_DIR;
      syncUnifiedMcpRegistryTargets({});

      expect(readJson(defaultConfigPath)).toEqual({
        mcpServers: { 'personal-notes': personalNotes, 'team-docs': teamDocs },
      });
    });

    it("keeps a server the user added to the file next to a profile, given a state from an older sync of the profile's own file", () => {
      // An OMC that already synced a profile into its own .claude.json wrote the
      // same older format: it synced `database` and `team-docs` into
      // ~/.claude-work/.claude.json. `database` has since left the registry, and the
      // user has added a `database` of their own to ~/.claude.json, the file next to
      // the profile.
      const defaultConfigPath = join(homeDir, '.claude.json');
      const profileDir = join(homeDir, '.claude-work');
      const profileConfigPath = join(profileDir, '.claude.json');
      const profileConfig = { mcpServers: { database: syncedDatabase, 'team-docs': teamDocs } };
      writeJson(profileConfigPath, profileConfig);
      writeJson(statePath(), { managedServers: ['database', 'team-docs'] });
      writeJson(defaultConfigPath, { mcpServers: { database: ownDatabase } });
      writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });

      process.env.CLAUDE_CONFIG_DIR = profileDir;
      syncUnifiedMcpRegistryTargets({});
      // The profile has both names, so neither is recorded for ~/.claude.json. The
      // `database` in the profile stays too, as the state does not say it came from there.
      expect(readJson(profileConfigPath)).toEqual(profileConfig);
      expect(readJson(statePath())).toEqual({
        managedServers: ['team-docs'],
        managedServersByClaudeConfig: { [resolve(profileConfigPath)]: ['team-docs'] },
      });

      delete process.env.CLAUDE_CONFIG_DIR;
      syncUnifiedMcpRegistryTargets({});

      expect(readJson(defaultConfigPath)).toEqual({
        mcpServers: { database: ownDatabase, 'team-docs': teamDocs },
      });
    });

    it('still removes a server that left the registry from CLAUDE_MCP_CONFIG_PATH, given a state from an older sync', () => {
      // An older OMC synced into the CLAUDE_MCP_CONFIG_PATH file as well.
      const mcpConfigPath = join(testRoot, 'custom', 'claude.json');
      process.env.CLAUDE_CONFIG_DIR = join(testRoot, 'profiles', 'work');
      process.env.CLAUDE_MCP_CONFIG_PATH = mcpConfigPath;
      writeJson(mcpConfigPath, { mcpServers: { database: syncedDatabase, 'team-docs': teamDocs } });
      writeJson(statePath(), { managedServers: ['database', 'team-docs'] });
      writeJson(getUnifiedMcpRegistryPath(), { 'team-docs': teamDocs });

      syncUnifiedMcpRegistryTargets({});

      expect(readJson(mcpConfigPath)).toEqual({ mcpServers: { 'team-docs': teamDocs } });
    });
  });
});
