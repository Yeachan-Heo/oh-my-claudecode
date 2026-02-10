/**
 * Plugin and MCP Server Discovery
 *
 * Discovers external plugins, MCP servers, and tools from:
 * - ~/.claude/plugins/ (Claude Code plugins)
 * - ~/.claude/settings.json (MCP servers config)
 * - ~/.claude/claude_desktop_config.json (Desktop app MCP config)
 * - Project-local .claude-plugin/ directories
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { join, basename, resolve, normalize } from 'path';
import { homedir } from 'os';
import Ajv from 'ajv';
/**
 * Security Error for discovery operations
 */
export class DiscoverySecurityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DiscoverySecurityError';
    }
}
/**
 * JSON Schema for plugin manifest validation
 */
const pluginManifestSchema = {
    type: 'object',
    required: ['name', 'version'],
    properties: {
        name: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', maxLength: 100 },
        version: { type: 'string', maxLength: 50 },
        description: { type: 'string', maxLength: 500 },
        namespace: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', maxLength: 100 },
        skills: {
            oneOf: [
                { type: 'string', maxLength: 200 },
                { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 50 },
            ],
        },
        agents: {
            oneOf: [
                { type: 'string', maxLength: 200 },
                { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 50 },
            ],
        },
        tools: {
            type: 'array',
            maxItems: 100,
            items: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', maxLength: 100 },
                    description: { type: 'string', maxLength: 500 },
                    inputSchema: { type: 'object' },
                },
                additionalProperties: false,
            },
        },
        permissions: {
            type: 'array',
            maxItems: 100,
            items: {
                type: 'object',
                properties: {
                    tool: { type: 'string', maxLength: 200 },
                    scope: { type: 'string', enum: ['read', 'write', 'execute'] },
                    patterns: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
                    reason: { type: 'string', maxLength: 500 },
                },
            },
        },
        mcpServers: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                required: ['command'],
                properties: {
                    command: { type: 'string', maxLength: 500 },
                    args: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
                    env: { type: 'object', additionalProperties: { type: 'string', maxLength: 1000 } },
                    enabled: { type: 'boolean' },
                },
            },
        },
    },
    additionalProperties: true,
};
/**
 * JSON Schema for MCP server config validation
 */
const mcpServerConfigSchema = {
    type: 'object',
    required: ['command'],
    properties: {
        command: { type: 'string', minLength: 1, maxLength: 500 },
        args: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
        env: { type: 'object', additionalProperties: { type: 'string', maxLength: 1000 } },
        enabled: { type: 'boolean' },
    },
    additionalProperties: false,
};
// Compile schemas
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvConstructor = Ajv.default ?? Ajv;
const ajv = new AjvConstructor({ allErrors: true, strict: false });
const validatePluginManifest = ajv.compile(pluginManifestSchema);
const validateMcpServerConfig = ajv.compile(mcpServerConfigSchema);
/**
 * SECURITY: Validate that a path stays within a base directory
 * Prevents path traversal attacks like ../../../../etc/passwd
 */
function isPathWithinDirectory(basePath, targetPath) {
    try {
        // Resolve both paths to absolute form
        const resolvedBase = resolve(basePath);
        const resolvedTarget = resolve(basePath, targetPath);
        // Normalize paths to handle ../ sequences
        const normalizedBase = normalize(resolvedBase);
        const normalizedTarget = normalize(resolvedTarget);
        // Check if target is within base (starts with base path)
        if (!normalizedTarget.startsWith(normalizedBase)) {
            return false;
        }
        // Additional check: verify the path actually exists within base
        // by checking real path (follows symlinks)
        if (existsSync(normalizedTarget)) {
            const realTarget = realpathSync(normalizedTarget);
            const realBase = existsSync(normalizedBase) ? realpathSync(normalizedBase) : normalizedBase;
            if (!realTarget.startsWith(realBase)) {
                return false;
            }
        }
        return true;
    }
    catch {
        return false;
    }
}
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
function inferCapabilities(name, description) {
    const capabilities = [];
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
 * Parse and validate a plugin manifest file
 */
function parsePluginManifest(manifestPath) {
    try {
        const content = readFileSync(manifestPath, 'utf-8');
        const parsed = JSON.parse(content);
        // SECURITY: Validate manifest against schema
        if (!validatePluginManifest(parsed)) {
            const errors = validatePluginManifest.errors
                ?.map((e) => `${e.instancePath}: ${e.message}`)
                .join(', ');
            console.warn(`[Security] Invalid plugin manifest at ${manifestPath}: ${errors}`);
            return null;
        }
        return parsed;
    }
    catch (error) {
        return null;
    }
}
/**
 * Discover skills from a plugin directory
 */
function discoverPluginSkills(pluginPath, manifest) {
    const tools = [];
    const namespace = manifest.namespace || manifest.name;
    // Handle skills directory
    let skillsPaths = [];
    if (typeof manifest.skills === 'string') {
        // SECURITY: Validate path stays within plugin directory
        if (!isPathWithinDirectory(pluginPath, manifest.skills)) {
            console.warn(`[Security] Path traversal detected in plugin ${manifest.name}: skills path "${manifest.skills}" escapes plugin directory`);
            return tools;
        }
        skillsPaths = [join(pluginPath, manifest.skills)];
    }
    else if (Array.isArray(manifest.skills)) {
        skillsPaths = [];
        for (const s of manifest.skills) {
            // SECURITY: Validate each path
            if (!isPathWithinDirectory(pluginPath, s)) {
                console.warn(`[Security] Path traversal detected in plugin ${manifest.name}: skills path "${s}" escapes plugin directory`);
                continue;
            }
            skillsPaths.push(join(pluginPath, s));
        }
    }
    for (const skillsPath of skillsPaths) {
        if (!existsSync(skillsPath))
            continue;
        try {
            const entries = readdirSync(skillsPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const skillMdPath = join(skillsPath, entry.name, 'SKILL.md');
                if (!existsSync(skillMdPath))
                    continue;
                // Parse skill metadata from SKILL.md frontmatter
                const skillContent = readFileSync(skillMdPath, 'utf-8');
                const frontmatterMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                const metadata = {};
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
        }
        catch {
            // Skip directories we can't read
        }
    }
    return tools;
}
/**
 * Discover agents from a plugin directory
 */
function discoverPluginAgents(pluginPath, manifest) {
    const tools = [];
    const namespace = manifest.namespace || manifest.name;
    // Handle agents directory
    let agentsPaths = [];
    if (typeof manifest.agents === 'string') {
        // SECURITY: Validate path stays within plugin directory
        if (!isPathWithinDirectory(pluginPath, manifest.agents)) {
            console.warn(`[Security] Path traversal detected in plugin ${manifest.name}: agents path "${manifest.agents}" escapes plugin directory`);
            return tools;
        }
        agentsPaths = [join(pluginPath, manifest.agents)];
    }
    else if (Array.isArray(manifest.agents)) {
        agentsPaths = [];
        for (const a of manifest.agents) {
            // SECURITY: Validate each path
            if (!isPathWithinDirectory(pluginPath, a)) {
                console.warn(`[Security] Path traversal detected in plugin ${manifest.name}: agents path "${a}" escapes plugin directory`);
                continue;
            }
            agentsPaths.push(join(pluginPath, a));
        }
    }
    for (const agentsPath of agentsPaths) {
        if (!existsSync(agentsPath))
            continue;
        try {
            const entries = readdirSync(agentsPath);
            for (const entry of entries) {
                if (!entry.endsWith('.md'))
                    continue;
                const agentPath = join(agentsPath, entry);
                const agentContent = readFileSync(agentPath, 'utf-8');
                const agentName = basename(entry, '.md');
                // Parse agent metadata from frontmatter
                const frontmatterMatch = agentContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                const metadata = {};
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
        }
        catch {
            // Skip directories we can't read
        }
    }
    return tools;
}
/**
 * Discover a single plugin from a directory
 */
function discoverPlugin(pluginPath) {
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
    const tools = [
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
export function discoverPlugins(options) {
    const plugins = [];
    const paths = options?.pluginPaths || DEFAULT_PLUGIN_PATHS;
    for (const basePath of paths) {
        if (!existsSync(basePath))
            continue;
        try {
            const entries = readdirSync(basePath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                // Skip our own plugin
                if (entry.name === 'oh-my-claudecode')
                    continue;
                const pluginPath = join(basePath, entry.name);
                const plugin = discoverPlugin(pluginPath);
                if (plugin) {
                    plugins.push(plugin);
                }
            }
        }
        catch {
            // Skip paths we can't read
        }
    }
    return plugins;
}
/**
 * Parse MCP servers from Claude Desktop config format
 */
function parseMcpDesktopConfig(configPath) {
    const servers = [];
    if (!existsSync(configPath)) {
        return servers;
    }
    try {
        const content = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        if (!config.mcpServers) {
            return servers;
        }
        for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
            // SECURITY: Validate server config against schema
            if (!validateMcpServerConfig(serverConfig)) {
                const errors = validateMcpServerConfig.errors
                    ?.map((e) => `${e.instancePath}: ${e.message}`)
                    .join(', ');
                console.warn(`[Security] Invalid MCP server config for "${name}": ${errors}`);
                continue;
            }
            servers.push({
                name,
                config: serverConfig,
                source: 'claude_desktop_config',
                connected: false,
                tools: [], // Tools discovered after connection
            });
        }
    }
    catch {
        // Ignore parse errors
    }
    return servers;
}
/**
 * Parse MCP servers from Claude Code settings.json
 */
function parseMcpSettings(settingsPath) {
    const servers = [];
    if (!existsSync(settingsPath)) {
        return servers;
    }
    try {
        const content = readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        if (!settings.mcpServers) {
            return servers;
        }
        for (const [name, serverConfig] of Object.entries(settings.mcpServers)) {
            // SECURITY: Validate server config against schema
            if (!validateMcpServerConfig(serverConfig)) {
                const errors = validateMcpServerConfig.errors
                    ?.map((e) => `${e.instancePath}: ${e.message}`)
                    .join(', ');
                console.warn(`[Security] Invalid MCP server config for "${name}": ${errors}`);
                continue;
            }
            servers.push({
                name,
                config: serverConfig,
                source: 'settings.json',
                connected: false,
                tools: [],
            });
        }
    }
    catch {
        // Ignore parse errors
    }
    return servers;
}
/**
 * Discover all MCP servers from configuration files
 */
export function discoverMcpServers(options) {
    const servers = [];
    const seen = new Set();
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
export function discoverPluginMcpServers(plugins) {
    const servers = [];
    for (const plugin of plugins) {
        if (!plugin.manifest.mcpServers)
            continue;
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
 * Perform full discovery of plugins and MCP servers
 */
export function discoverAll(options) {
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
    const allTools = [];
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
export function getPluginPaths() {
    return DEFAULT_PLUGIN_PATHS.filter(p => existsSync(p));
}
/**
 * Get path to MCP config file if it exists
 */
export function getMcpConfigPath() {
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
export function isPluginInstalled(pluginName) {
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
export function getPluginInfo(pluginName) {
    for (const basePath of DEFAULT_PLUGIN_PATHS) {
        const pluginPath = join(basePath, pluginName);
        if (existsSync(pluginPath)) {
            return discoverPlugin(pluginPath);
        }
    }
    return null;
}
//# sourceMappingURL=discovery.js.map