import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import { getClaudeMcpConfigPath, getCodexConfigPath, getUnifiedMcpRegistryPath, inspectUnifiedMcpRegistrySync, syncUnifiedMcpRegistryTargets, } from '../mcp-registry.js';
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
];
describe('Claude MCP config path follows CLAUDE_CONFIG_DIR', () => {
    let testRoot;
    // The user's home: a profile at <homeDir>/.claude-work sits next to
    // <homeDir>/.claude.json, the default profile's file.
    let homeDir;
    const savedEnv = new Map();
    const writeJson = (path, value) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(value, null, 2));
    };
    const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
    beforeEach(() => {
        for (const key of ENV_KEYS)
            savedEnv.set(key, process.env[key]);
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
            }
            else {
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
});
//# sourceMappingURL=claude-mcp-config-path.test.js.map