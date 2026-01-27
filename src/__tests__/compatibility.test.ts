/**
 * Tests for the Compatibility Layer
 *
 * Tests plugin discovery, tool registry, permission adapter, and MCP bridge.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

// Import types
import type {
  ExternalTool,
  PluginManifest,
  DiscoveredPlugin,
  DiscoveredMcpServer,
} from '../compatibility/types.js';

// Import functions under test
import {
  discoverPlugins,
  discoverMcpServers,
  discoverAll,
  getPluginInfo,
  isPluginInstalled,
} from '../compatibility/discovery.js';

import {
  ToolRegistry,
  getRegistry,
  routeCommand,
  getExternalTool,
  listExternalTools,
} from '../compatibility/registry.js';

import {
  checkPermission,
  grantPermission,
  denyPermission,
  clearPermissionCache,
  addSafePattern,
  getSafePatterns,
  shouldDelegate,
  getDelegationTarget,
} from '../compatibility/permission-adapter.js';

// Test fixtures
const TEST_DIR = join(tmpdir(), 'omc-compat-test-' + Date.now());
const TEST_PLUGINS_DIR = join(TEST_DIR, 'plugins');
const TEST_MCP_CONFIG = join(TEST_DIR, 'claude_desktop_config.json');
const TEST_SETTINGS = join(TEST_DIR, 'settings.json');

/**
 * Create a test plugin directory structure
 */
function createTestPlugin(name: string, manifest: Partial<PluginManifest>): string {
  const pluginDir = join(TEST_PLUGINS_DIR, name);
  const manifestPath = join(pluginDir, 'plugin.json');

  mkdirSync(pluginDir, { recursive: true });

  const fullManifest: PluginManifest = {
    name,
    version: '1.0.0',
    ...manifest,
  };

  writeFileSync(manifestPath, JSON.stringify(fullManifest, null, 2));

  // Create skills directory if specified
  if (manifest.skills) {
    const skillsDir = join(pluginDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Create a sample skill
    const sampleSkillDir = join(skillsDir, 'sample-skill');
    mkdirSync(sampleSkillDir, { recursive: true });
    writeFileSync(join(sampleSkillDir, 'SKILL.md'), `---
name: sample-skill
description: A sample skill for testing
---

This is a sample skill.
`);
  }

  return pluginDir;
}

/**
 * Create a test MCP config file
 */
function createTestMcpConfig(servers: Record<string, { command: string; args?: string[] }>): void {
  writeFileSync(TEST_MCP_CONFIG, JSON.stringify({ mcpServers: servers }, null, 2));
}

/**
 * Create a test settings file
 */
function createTestSettings(servers: Record<string, { command: string; args?: string[] }>): void {
  writeFileSync(TEST_SETTINGS, JSON.stringify({ mcpServers: servers }, null, 2));
}

// ============================================================
// Discovery Tests
// ============================================================

describe('Discovery System', () => {
  beforeEach(() => {
    mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('discoverPlugins', () => {
    it('should discover plugins in the configured directory', () => {
      createTestPlugin('test-plugin', {
        description: 'Test plugin',
        skills: './skills/',
      });

      const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });

      expect(plugins.length).toBeGreaterThan(0);
      const testPlugin = plugins.find(p => p.name === 'test-plugin');
      expect(testPlugin).toBeDefined();
      expect(testPlugin?.loaded).toBe(true);
      expect(testPlugin?.manifest.description).toBe('Test plugin');
    });

    it('should discover skills from plugins', () => {
      createTestPlugin('skill-plugin', {
        skills: './skills/',
      });

      const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
      const plugin = plugins.find(p => p.name === 'skill-plugin');

      expect(plugin).toBeDefined();
      expect(plugin?.tools.length).toBeGreaterThan(0);

      const skill = plugin?.tools.find(t => t.name.includes('sample-skill'));
      expect(skill).toBeDefined();
      expect(skill?.type).toBe('skill');
    });

    it('should return empty array for non-existent directory', () => {
      const plugins = discoverPlugins({ pluginPaths: ['/nonexistent/path'] });
      expect(plugins).toHaveLength(0);
    });

    it('should skip oh-my-claudecode plugin directory', () => {
      createTestPlugin('oh-my-claudecode', {
        description: 'Should be skipped',
      });

      const plugins = discoverPlugins({ pluginPaths: [TEST_PLUGINS_DIR] });
      const omcPlugin = plugins.find(p => p.name === 'oh-my-claudecode');
      expect(omcPlugin).toBeUndefined();
    });
  });

  describe('discoverMcpServers', () => {
    it('should discover MCP servers from claude_desktop_config.json', () => {
      createTestMcpConfig({
        'test-server': {
          command: 'npx',
          args: ['-y', 'test-server'],
        },
      });

      const servers = discoverMcpServers({ mcpConfigPath: TEST_MCP_CONFIG });

      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('test-server');
      expect(servers[0].source).toBe('claude_desktop_config');
    });

    it('should discover MCP servers from settings.json', () => {
      createTestSettings({
        'settings-server': {
          command: 'node',
          args: ['server.js'],
        },
      });

      const servers = discoverMcpServers({ settingsPath: TEST_SETTINGS });

      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('settings-server');
      expect(servers[0].source).toBe('settings.json');
    });

    it('should prioritize settings.json over claude_desktop_config.json', () => {
      createTestSettings({
        'shared-server': {
          command: 'settings-command',
        },
      });
      createTestMcpConfig({
        'shared-server': {
          command: 'desktop-command',
        },
      });

      const servers = discoverMcpServers({
        settingsPath: TEST_SETTINGS,
        mcpConfigPath: TEST_MCP_CONFIG,
      });

      expect(servers).toHaveLength(1);
      expect(servers[0].config.command).toBe('settings-command');
    });
  });

  describe('discoverAll', () => {
    it('should discover both plugins and MCP servers', () => {
      createTestPlugin('combined-plugin', { description: 'Combined test' });
      createTestMcpConfig({
        'combined-server': { command: 'npx', args: ['server'] },
      });

      const result = discoverAll({
        pluginPaths: [TEST_PLUGINS_DIR],
        mcpConfigPath: TEST_MCP_CONFIG,
      });

      expect(result.plugins.length).toBeGreaterThan(0);
      expect(result.mcpServers.length).toBeGreaterThan(0);
      expect(result.timestamp).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// Registry Tests
// ============================================================

describe('Tool Registry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    ToolRegistry.resetInstance();
    registry = new ToolRegistry();
  });

  describe('registerTool', () => {
    it('should register a tool', () => {
      const tool: ExternalTool = {
        name: 'test:tool',
        type: 'plugin',
        source: 'test-plugin',
        enabled: true,
      };

      registry.registerTool(tool);
      expect(registry.getTool('test:tool')).toBeDefined();
    });

    it('should handle tool name conflicts by priority', () => {
      const lowPriority: ExternalTool = {
        name: 'conflict:tool',
        type: 'plugin',
        source: 'low-priority',
        enabled: true,
        priority: 10,
      };

      const highPriority: ExternalTool = {
        name: 'conflict:tool',
        type: 'plugin',
        source: 'high-priority',
        enabled: true,
        priority: 100,
      };

      registry.registerTool(lowPriority);
      registry.registerTool(highPriority);

      const tool = registry.getTool('conflict:tool');
      expect(tool?.source).toBe('high-priority');
    });

    it('should track conflicts', () => {
      const tool1: ExternalTool = {
        name: 'conflict:tool',
        type: 'plugin',
        source: 'plugin-1',
        enabled: true,
      };

      const tool2: ExternalTool = {
        name: 'conflict:tool',
        type: 'plugin',
        source: 'plugin-2',
        enabled: true,
      };

      registry.registerTool(tool1);
      registry.registerTool(tool2);

      const conflicts = registry.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].tools).toHaveLength(2);
    });
  });

  describe('getTool', () => {
    it('should find tool by exact name', () => {
      const tool: ExternalTool = {
        name: 'exact:match',
        type: 'plugin',
        source: 'test',
        enabled: true,
      };

      registry.registerTool(tool);
      expect(registry.getTool('exact:match')).toBeDefined();
    });

    it('should find tool by short name', () => {
      const tool: ExternalTool = {
        name: 'namespace:shortname',
        type: 'plugin',
        source: 'test',
        enabled: true,
      };

      registry.registerTool(tool);
      expect(registry.getTool('shortname')).toBeDefined();
    });
  });

  describe('route', () => {
    it('should create route for registered tool', () => {
      const tool: ExternalTool = {
        name: 'route:test',
        type: 'plugin',
        source: 'test-plugin',
        enabled: true,
        capabilities: ['read'],
      };

      registry.registerTool(tool);
      const route = registry.route('route:test');

      expect(route).toBeDefined();
      expect(route?.tool.name).toBe('route:test');
      expect(route?.requiresPermission).toBe(false);
    });

    it('should require permission for write/execute tools', () => {
      const tool: ExternalTool = {
        name: 'dangerous:tool',
        type: 'plugin',
        source: 'test',
        enabled: true,
        capabilities: ['write', 'execute'],
      };

      registry.registerTool(tool);
      const route = registry.route('dangerous:tool');

      expect(route?.requiresPermission).toBe(true);
    });
  });

  describe('getToolsBySource', () => {
    it('should filter tools by source', () => {
      registry.registerTool({
        name: 'source1:tool1',
        type: 'plugin',
        source: 'source1',
        enabled: true,
      });
      registry.registerTool({
        name: 'source1:tool2',
        type: 'plugin',
        source: 'source1',
        enabled: true,
      });
      registry.registerTool({
        name: 'source2:tool1',
        type: 'plugin',
        source: 'source2',
        enabled: true,
      });

      const tools = registry.getToolsBySource('source1');
      expect(tools).toHaveLength(2);
    });
  });

  describe('searchTools', () => {
    it('should search tools by keyword', () => {
      registry.registerTool({
        name: 'search:file-reader',
        type: 'plugin',
        source: 'test',
        description: 'Reads files from disk',
        enabled: true,
      });
      registry.registerTool({
        name: 'search:file-writer',
        type: 'plugin',
        source: 'test',
        description: 'Writes files to disk',
        enabled: true,
      });

      const results = registry.searchTools('file');
      expect(results).toHaveLength(2);

      const readerOnly = registry.searchTools('reader');
      expect(readerOnly).toHaveLength(1);
    });
  });
});

// ============================================================
// Permission Adapter Tests
// ============================================================

describe('Permission Adapter', () => {
  beforeEach(() => {
    clearPermissionCache();
    ToolRegistry.resetInstance();
  });

  describe('checkPermission', () => {
    it('should allow built-in safe MCP tools', () => {
      const result = checkPermission('mcp__context7__query-docs');
      expect(result.allowed).toBe(true);
    });

    it('should require permission for write operations', () => {
      const result = checkPermission('mcp__filesystem__write_file', { path: '/test' });
      expect(result.allowed).toBe(false);
      expect(result.askUser).toBe(true);
    });

    it('should cache permission decisions', () => {
      const first = checkPermission('mcp__context7__query-docs');
      const second = checkPermission('mcp__context7__query-docs');
      expect(first).toEqual(second);
    });
  });

  describe('grantPermission', () => {
    it('should cache granted permission', () => {
      grantPermission('custom:tool');
      const result = checkPermission('custom:tool');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('User granted permission');
    });
  });

  describe('denyPermission', () => {
    it('should cache denied permission', () => {
      denyPermission('custom:tool');
      const result = checkPermission('custom:tool');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('User denied permission');
    });
  });

  describe('addSafePattern', () => {
    it('should add custom safe patterns', () => {
      addSafePattern({
        tool: 'custom:safe-tool',
        pattern: /.*/,
        description: 'Custom safe tool',
        source: 'test',
      });

      const patterns = getSafePatterns();
      const found = patterns.find(p => p.tool === 'custom:safe-tool');
      expect(found).toBeDefined();
    });
  });

  describe('shouldDelegate', () => {
    it('should delegate plugin tools', () => {
      const registry = getRegistry();
      registry.registerTool({
        name: 'external:tool',
        type: 'plugin',
        source: 'external-plugin',
        enabled: true,
      });

      expect(shouldDelegate('external:tool')).toBe(true);
    });

    it('should delegate MCP tools', () => {
      const registry = getRegistry();
      registry.registerTool({
        name: 'mcp:tool',
        type: 'mcp',
        source: 'mcp-server',
        enabled: true,
      });

      expect(shouldDelegate('mcp:tool')).toBe(true);
    });
  });

  describe('getDelegationTarget', () => {
    it('should return plugin target for plugin tools', () => {
      const registry = getRegistry();
      registry.registerTool({
        name: 'plugin:tool',
        type: 'plugin',
        source: 'my-plugin',
        enabled: true,
      });

      const target = getDelegationTarget('plugin:tool');
      expect(target?.type).toBe('plugin');
      expect(target?.target).toBe('my-plugin');
    });

    it('should return mcp target for MCP tools', () => {
      const registry = getRegistry();
      registry.registerTool({
        name: 'mcp:tool',
        type: 'mcp',
        source: 'my-server',
        enabled: true,
      });

      const target = getDelegationTarget('mcp:tool');
      expect(target?.type).toBe('mcp');
      expect(target?.target).toBe('my-server');
    });
  });
});

// ============================================================
// Event Listener Tests
// ============================================================

describe('Registry Events', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    ToolRegistry.resetInstance();
    registry = new ToolRegistry();
  });

  it('should emit tool-registered event', () => {
    const listener = vi.fn();
    registry.addEventListener(listener);

    registry.registerTool({
      name: 'event:tool',
      type: 'plugin',
      source: 'test',
      enabled: true,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-registered',
        data: expect.objectContaining({ tool: 'event:tool' }),
      })
    );
  });

  it('should emit tool-conflict event', () => {
    const listener = vi.fn();
    registry.addEventListener(listener);

    registry.registerTool({
      name: 'conflict:tool',
      type: 'plugin',
      source: 'first',
      enabled: true,
    });
    registry.registerTool({
      name: 'conflict:tool',
      type: 'plugin',
      source: 'second',
      enabled: true,
    });

    const conflictEvent = listener.mock.calls.find(
      call => call[0].type === 'tool-conflict'
    );
    expect(conflictEvent).toBeDefined();
  });

  it('should allow removing event listeners', () => {
    const listener = vi.fn();
    registry.addEventListener(listener);
    registry.removeEventListener(listener);

    registry.registerTool({
      name: 'removed:tool',
      type: 'plugin',
      source: 'test',
      enabled: true,
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
