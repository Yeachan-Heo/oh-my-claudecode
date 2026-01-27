/**
 * Plugin and MCP Server Discovery
 *
 * Discovers external plugins, MCP servers, and tools from:
 * - ~/.claude/plugins/ (Claude Code plugins)
 * - ~/.claude/settings.json (MCP servers config)
 * - ~/.claude/claude_desktop_config.json (Desktop app MCP config)
 * - Project-local .claude-plugin/ directories
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import type {
  DiscoveryOptions,
  DiscoveredPlugin,
  DiscoveredMcpServer,
  PluginManifest,
  McpServerEntry,
  ExternalTool,
  ToolCapability,
} from './types.js';

/**
 * Default paths for discovery
 */
const DEFAULT_PLUGIN_PATHS = [
  join(homedir(), '.claude', 'plugins'),
  join(homedir(), '.claude', 'installed-plugins'),
];

const DEFAULT_MCP_CONFIG_PATH = join(homedir(), '.claude', 'claude_desktop_config.json');
const DEFAULT_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/**
 * Infer capabilities from tool name and description
 */
function inferCapabilities(name: string, description?: string): ToolCapability[] {
  const capabilities: ToolCapability[] = [];
  const text = `${name} ${description || ''}`.toLowerCase();

  if (text.includes('read') || text.includes('get') || text.includes('fetch') || text.includes('list')) {
    capabilities.push('read');
  }
  if (text.includes('write') || text.includes('create') || text.includes('update') || text.includes('edit')) {
    capabilities.push('write');
  }
  if (text.includes('exec') || text.includes('run') || text.includes('bash') || text.includes('command')) {
    capabilities.push('execute');
  }
  if (text.includes('search') || text.includes('find') || text.includes('query') || text.includes('grep')) {
    capabilities.push('search');
  }
  if (text.includes('http') || text.includes('fetch') || text.includes('web') || text.includes('api')) {
    capabilities.push('network');
  }
  if (text.includes('analyz') || text.includes('inspect') || text.includes('check') || text.includes('review')) {
    capabilities.push('analyze');
  }
  if (text.includes('generat') || text.includes('creat') || text.includes('build') || text.includes('make')) {
    capabilities.push('generate');
  }

  return capabilities.length > 0 ? capabilities : ['unknown'];
}

/**
 * Parse a plugin manifest file
 */
function parsePluginManifest(manifestPath: string): PluginManifest | null {
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as PluginManifest;
  } catch (error) {
    return null;
  }
}

/**
 * Discover skills from a plugin directory
 */
function discoverPluginSkills(pluginPath: string, manifest: PluginManifest): ExternalTool[] {
  const tools: ExternalTool[] = [];
  const namespace = manifest.namespace || manifest.name;

  // Handle skills directory
  let skillsPaths: string[] = [];
  if (typeof manifest.skills === 'string') {
    skillsPaths = [join(pluginPath, manifest.skills)];
  } else if (Array.isArray(manifest.skills)) {
    skillsPaths = manifest.skills.map(s => join(pluginPath, s));
  }

  for (const skillsPath of skillsPaths) {
    if (!existsSync(skillsPath)) continue;

    try {
      const entries = readdirSync(skillsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillMdPath = join(skillsPath, entry.name, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;

        // Parse skill metadata from SKILL.md frontmatter
        const skillContent = readFileSync(skillMdPath, 'utf-8');
        const frontmatterMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const metadata: Record<string, string> = {};

        if (frontmatterMatch) {
          for (const line of frontmatterMatch[1].split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              const key = line.slice(0, colonIdx).trim();
              let value = line.slice(colonIdx + 1).trim();
              // Remove quotes
              if ((value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
              }
              metadata[key] = value;
            }
          }
        }

        tools.push({
          name: `${namespace}:${entry.name}`,
          type: 'skill',
          source: manifest.name,
          description: metadata.description || `Skill from ${manifest.name}`,
          commands: [entry.name],
          capabilities: inferCapabilities(entry.name, metadata.description),
          enabled: true,
          priority: 50, // Default priority for external skills
        });
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return tools;
}

/**
 * Discover agents from a plugin directory
 */
function discoverPluginAgents(pluginPath: string, manifest: PluginManifest): ExternalTool[] {
  const tools: ExternalTool[] = [];
  const namespace = manifest.namespace || manifest.name;

  // Handle agents directory
  let agentsPaths: string[] = [];
  if (typeof manifest.agents === 'string') {
    agentsPaths = [join(pluginPath, manifest.agents)];
  } else if (Array.isArray(manifest.agents)) {
    agentsPaths = manifest.agents.map(a => join(pluginPath, a));
  }

  for (const agentsPath of agentsPaths) {
    if (!existsSync(agentsPath)) continue;

    try {
      const entries = readdirSync(agentsPath);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;

        const agentPath = join(agentsPath, entry);
        const agentContent = readFileSync(agentPath, 'utf-8');
        const agentName = basename(entry, '.md');

        // Parse agent metadata from frontmatter
        const frontmatterMatch = agentContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const metadata: Record<string, string> = {};

        if (frontmatterMatch) {
          for (const line of frontmatterMatch[1].split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              const key = line.slice(0, colonIdx).trim();
              let value = line.slice(colonIdx + 1).trim();
              if ((value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
              }
              metadata[key] = value;
            }
          }
        }

        tools.push({
          name: `${namespace}:${agentName}`,
          type: 'agent',
          source: manifest.name,
          description: metadata.description || `Agent from ${manifest.name}`,
          capabilities: ['analyze', 'generate'],
          enabled: true,
          priority: 50,
        });
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return tools;
}

/**
 * Discover a single plugin from a directory
 */
function discoverPlugin(pluginPath: string): DiscoveredPlugin | null {
  // Look for plugin.json in the directory or in .claude-plugin subdirectory
  let manifestPath = join(pluginPath, 'plugin.json');
  if (!existsSync(manifestPath)) {
    manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json');
  }
  if (!existsSync(manifestPath)) {
    return null;
  }

  const manifest = parsePluginManifest(manifestPath);
  if (!manifest) {
    return {
      name: basename(pluginPath),
      version: 'unknown',
      path: pluginPath,
      manifest: { name: basename(pluginPath), version: 'unknown' },
      loaded: false,
      error: 'Failed to parse plugin manifest',
      tools: [],
    };
  }

  // Discover tools from this plugin
  const tools: ExternalTool[] = [
    ...discoverPluginSkills(pluginPath, manifest),
    ...discoverPluginAgents(pluginPath, manifest),
  ];

  // Add tool definitions from manifest
  if (manifest.tools) {
    for (const toolDef of manifest.tools) {
      tools.push({
        name: `${manifest.namespace || manifest.name}:${toolDef.name}`,
        type: 'plugin',
        source: manifest.name,
        description: toolDef.description,
        capabilities: inferCapabilities(toolDef.name, toolDef.description),
        enabled: true,
        schema: toolDef.inputSchema,
        priority: 50,
      });
    }
  }

  return {
    name: manifest.name,
    version: manifest.version,
    path: pluginPath,
    manifest,
    loaded: true,
    tools,
  };
}

/**
 * Discover all plugins from configured paths
 */
export function discoverPlugins(options?: DiscoveryOptions): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];
  const paths = options?.pluginPaths || DEFAULT_PLUGIN_PATHS;

  for (const basePath of paths) {
    if (!existsSync(basePath)) continue;

    try {
      const entries = readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Skip our own plugin
        if (entry.name === 'oh-my-claudecode') continue;

        const pluginPath = join(basePath, entry.name);
        const plugin = discoverPlugin(pluginPath);
        if (plugin) {
          plugins.push(plugin);
        }
      }
    } catch {
      // Skip paths we can't read
    }
  }

  return plugins;
}

/**
 * Parse MCP servers from Claude Desktop config format
 */
function parseMcpDesktopConfig(configPath: string): DiscoveredMcpServer[] {
  const servers: DiscoveredMcpServer[] = [];

  if (!existsSync(configPath)) {
    return servers;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as {
      mcpServers?: Record<string, McpServerEntry>;
    };

    if (!config.mcpServers) {
      return servers;
    }

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      servers.push({
        name,
        config: serverConfig,
        source: 'claude_desktop_config',
        connected: false,
        tools: [], // Tools discovered after connection
      });
    }
  } catch {
    // Ignore parse errors
  }

  return servers;
}

/**
 * Parse MCP servers from Claude Code settings.json
 */
function parseMcpSettings(settingsPath: string): DiscoveredMcpServer[] {
  const servers: DiscoveredMcpServer[] = [];

  if (!existsSync(settingsPath)) {
    return servers;
  }

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as {
      mcpServers?: Record<string, McpServerEntry>;
    };

    if (!settings.mcpServers) {
      return servers;
    }

    for (const [name, serverConfig] of Object.entries(settings.mcpServers)) {
      servers.push({
        name,
        config: serverConfig,
        source: 'settings.json',
        connected: false,
        tools: [],
      });
    }
  } catch {
    // Ignore parse errors
  }

  return servers;
}

/**
 * Discover all MCP servers from configuration files
 */
export function discoverMcpServers(options?: DiscoveryOptions): DiscoveredMcpServer[] {
  const servers: DiscoveredMcpServer[] = [];
  const seen = new Set<string>();

  // Check settings.json first (higher priority)
  const settingsPath = options?.settingsPath || DEFAULT_SETTINGS_PATH;
  const settingsServers = parseMcpSettings(settingsPath);
  for (const server of settingsServers) {
    if (!seen.has(server.name)) {
      servers.push(server);
      seen.add(server.name);
    }
  }

  // Check claude_desktop_config.json
  const mcpConfigPath = options?.mcpConfigPath || DEFAULT_MCP_CONFIG_PATH;
  const desktopServers = parseMcpDesktopConfig(mcpConfigPath);
  for (const server of desktopServers) {
    if (!seen.has(server.name)) {
      servers.push(server);
      seen.add(server.name);
    }
  }

  return servers;
}

/**
 * Discover MCP servers from plugin manifests
 */
export function discoverPluginMcpServers(plugins: DiscoveredPlugin[]): DiscoveredMcpServer[] {
  const servers: DiscoveredMcpServer[] = [];

  for (const plugin of plugins) {
    if (!plugin.manifest.mcpServers) continue;

    for (const [name, serverConfig] of Object.entries(plugin.manifest.mcpServers)) {
      servers.push({
        name: `${plugin.name}:${name}`,
        config: serverConfig,
        source: plugin.name,
        connected: false,
        tools: [],
      });
    }
  }

  return servers;
}

/**
 * Full discovery of all external resources
 */
export interface DiscoveryResult {
  plugins: DiscoveredPlugin[];
  mcpServers: DiscoveredMcpServer[];
  allTools: ExternalTool[];
  timestamp: number;
}

/**
 * Perform full discovery of plugins and MCP servers
 */
export function discoverAll(options?: DiscoveryOptions): DiscoveryResult {
  // Discover plugins
  const plugins = discoverPlugins(options);

  // Discover MCP servers from config files
  const configMcpServers = discoverMcpServers(options);

  // Discover MCP servers from plugin manifests
  const pluginMcpServers = discoverPluginMcpServers(plugins);

  // Merge MCP servers (config takes priority)
  const mcpServers = [...configMcpServers];
  const seenServers = new Set(configMcpServers.map(s => s.name));
  for (const server of pluginMcpServers) {
    if (!seenServers.has(server.name)) {
      mcpServers.push(server);
    }
  }

  // Collect all tools
  const allTools: ExternalTool[] = [];
  for (const plugin of plugins) {
    allTools.push(...plugin.tools);
  }

  return {
    plugins,
    mcpServers,
    allTools,
    timestamp: Date.now(),
  };
}

/**
 * Get paths being scanned for plugins
 */
export function getPluginPaths(): string[] {
  return DEFAULT_PLUGIN_PATHS.filter(p => existsSync(p));
}

/**
 * Get path to MCP config file if it exists
 */
export function getMcpConfigPath(): string | null {
  if (existsSync(DEFAULT_MCP_CONFIG_PATH)) {
    return DEFAULT_MCP_CONFIG_PATH;
  }
  if (existsSync(DEFAULT_SETTINGS_PATH)) {
    return DEFAULT_SETTINGS_PATH;
  }
  return null;
}

/**
 * Check if a specific plugin is installed
 */
export function isPluginInstalled(pluginName: string): boolean {
  for (const basePath of DEFAULT_PLUGIN_PATHS) {
    const pluginPath = join(basePath, pluginName);
    if (existsSync(pluginPath)) {
      return true;
    }
  }
  return false;
}

/**
 * Get plugin info by name
 */
export function getPluginInfo(pluginName: string): DiscoveredPlugin | null {
  for (const basePath of DEFAULT_PLUGIN_PATHS) {
    const pluginPath = join(basePath, pluginName);
    if (existsSync(pluginPath)) {
      return discoverPlugin(pluginPath);
    }
  }
  return null;
}
