# MCP/Plugin Compatibility Layer

The Compatibility Layer enables oh-my-claudecode to discover, register, and use external plugins, MCP servers, and tools. It provides a unified interface for managing external tools while maintaining security through an integrated permission system.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Plugin Discovery](#plugin-discovery)
- [MCP Server Discovery](#mcp-server-discovery)
- [Plugin Manifest Format](#plugin-manifest-format)
- [Tool Registration](#tool-registration)
- [Permission System](#permission-system)
- [MCP Bridge](#mcp-bridge)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

## Overview

The Compatibility Layer consists of four integrated systems working together:

1. **Discovery System** - Automatically finds plugins and MCP servers from user directories
2. **Tool Registry** - Central hub that registers and manages all external tools with conflict resolution
3. **Permission Adapter** - Integrates with OMC's permission system for safe tool execution
4. **MCP Bridge** - Connects to MCP servers and exposes their tools for use

```
Plugins              MCP Configs          OMC Tools
   ↓                      ↓                    ↓
 Discovery System ────────────────────────────┐
                                              ↓
                           Tool Registry ← ← ←┘
                              ↓
                         Permission Adapter
                              ↓
                           MCP Bridge
```

## Architecture

### Discovery System (`discovery.ts`)

Scans for external plugins and MCP servers from:

- `~/.claude/plugins/` - OMC/Claude Code plugins directory
- `~/.claude/installed-plugins/` - Alternative plugins location
- `~/.claude/settings.json` - Claude Code MCP server configs
- `~/.claude/claude_desktop_config.json` - Claude Desktop MCP server configs
- Plugin manifests (`plugin.json`) for embedded MCP servers

**Discovers:**
- Plugin skills and agents (from SKILL.md and agent .md files)
- MCP server configurations
- Tool definitions from plugin manifests

### Tool Registry (`registry.ts`)

Central hub for tool management:

- Registers tools from discovered plugins and MCP servers
- Handles tool name conflicts using priority-based resolution
- Routes commands to appropriate handlers
- Provides search and filtering capabilities
- Emits events for registration and connection status

**Key features:**
- Tools are namespaced (e.g., `plugin-name:tool-name`)
- Priority system for conflict resolution (higher priority wins)
- Short name lookup (finds `tool-name` even with namespace)
- Event listeners for monitoring registry state

### Permission Adapter (`permission-adapter.ts`)

Integrates external tools with OMC's permission system:

- Maintains safe patterns for read-only tools
- Auto-approves known-safe operations
- Prompts user for dangerous operations (write, execute)
- Caches permission decisions
- Determines delegation targets for tool execution

**Safe patterns:**
- Built-in patterns for common MCP tools (filesystem read, context7 queries)
- Plugin-contributed patterns from manifests
- Custom patterns can be registered at runtime

### MCP Bridge (`mcp-bridge.ts`)

Manages MCP server connections:

- Spawns server processes
- Sends JSON-RPC requests and handles responses
- Discovers tools and resources from servers
- Routes tool invocations to servers
- Handles connection lifecycle (connect, disconnect, reconnect)

**Protocol:** JSON-RPC 2.0 over process stdio with newline-delimited messages

## Plugin Discovery

### Directory Structure

Plugins are discovered from `~/.claude/plugins/` and `~/.claude/installed-plugins/`:

```
~/.claude/plugins/
├── my-plugin/
│   ├── plugin.json          (required)
│   ├── skills/              (optional)
│   │   ├── skill-1/
│   │   │   └── SKILL.md
│   │   └── skill-2/
│   │       └── SKILL.md
│   ├── agents/              (optional)
│   │   ├── agent-1.md
│   │   └── agent-2.md
│   └── commands/            (optional)
└── another-plugin/
    └── plugin.json
```

### Plugin Manifest Structure

The `plugin.json` defines the plugin's metadata and tools:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My awesome plugin",
  "namespace": "my-plugin",
  "skills": "./skills/",
  "agents": "./agents/",
  "commands": "./commands/",
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["server.js"],
      "env": {},
      "enabled": true,
      "description": "My MCP server"
    }
  },
  "permissions": [
    {
      "tool": "my-plugin:search",
      "scope": "read",
      "patterns": [".*"],
      "reason": "Search is read-only"
    }
  ],
  "tools": [
    {
      "name": "my-tool",
      "description": "Does something useful",
      "handler": "tools/my-tool.js",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        }
      }
    }
  ]
}
```

### Skill and Agent Discovery

**Skills** are discovered from `SKILL.md` files in the skills directory. Each skill directory must contain a SKILL.md with frontmatter:

```markdown
---
name: my-skill
description: Describes what this skill does
tags: tag1, tag2
---

Skill documentation here...
```

**Agents** are discovered from `.md` files in the agents directory with similar frontmatter structure.

## MCP Server Discovery

### Claude Desktop Config

Located at `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/"],
      "enabled": true
    },
    "web": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-web"],
      "enabled": true
    }
  }
}
```

### Claude Code Settings

Located at `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "secret"
      }
    }
  }
}
```

### Plugin-Embedded MCP Servers

Plugins can define MCP servers in their manifest:

```json
{
  "name": "plugin-with-server",
  "mcpServers": {
    "my-mcp": {
      "command": "node",
      "args": ["./mcp/server.js"]
    }
  }
}
```

## Plugin Manifest Format

### Complete Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Plugin name (alphanumeric, hyphens, underscores) |
| `version` | string | Yes | Semantic version (e.g., "1.0.0") |
| `description` | string | No | Human-readable description |
| `namespace` | string | No | Prefix for tool names (defaults to plugin name) |
| `skills` | string\|string[] | No | Path(s) to skills directory |
| `agents` | string\|string[] | No | Path(s) to agents directory |
| `commands` | string\|string[] | No | Path(s) to commands directory |
| `mcpServers` | object | No | MCP server configurations (name → McpServerEntry) |
| `permissions` | PluginPermission[] | No | Permissions needed for plugin tools |
| `tools` | PluginToolDefinition[] | No | Tool definitions |

### McpServerEntry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Command to run server (e.g., "node", "npx") |
| `args` | string[] | No | Command arguments |
| `env` | object | No | Environment variables to pass to server |
| `enabled` | boolean | No | Whether server connects on init (default: true) |
| `description` | string | No | Human-readable description |

### PluginPermission

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name requiring permission |
| `scope` | "read"\|"write"\|"execute"\|"all" | Permission scope |
| `patterns` | string[] | Regex patterns for allowed paths/commands |
| `reason` | string | Why this permission is needed |

### PluginToolDefinition

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Tool name (becomes `namespace:name`) |
| `description` | string | Human-readable description |
| `handler` | string | Path to handler function or command |
| `inputSchema` | object | JSON Schema for tool input |

## Tool Registration

### Registration Process

Tools are registered in this order:

1. **Plugin discovery** - Plugins found in configured paths
2. **Tool extraction** - Skills, agents, and tool definitions extracted from plugins
3. **MCP server discovery** - MCP servers found from config files
4. **Tool conversion** - MCP tools converted to ExternalTool format
5. **Conflict resolution** - Tools with same name resolved by priority

### Tool Naming

Tools use a namespaced format:

```
{namespace}:{tool-name}

Examples:
- my-plugin:search
- filesystem:read_file
- context7:query-docs
```

Short names also work:
```javascript
getRegistry().getTool('search')     // Finds 'my-plugin:search'
getRegistry().getTool('my-plugin:search')  // Exact match
```

### Conflict Resolution

When two plugins provide a tool with the same name:

1. **Priority value** - Tool with higher priority wins (default: 50)
2. **Namespace** - Use full namespaced name to disambiguate
3. **Manual** - Check conflicts and re-register with different priority

```javascript
// Check for conflicts
const conflicts = registry.getConflicts();

// Get winner for conflict
const winner = conflicts[0].winner;
console.log(`${winner.source} won with priority ${winner.priority}`);
```

## Permission System

### Safe Patterns

Read-only tools are auto-approved without user prompting:

```javascript
// Check if tool is safe
const result = checkPermission('mcp__filesystem__read_file');
// { allowed: true, reason: "Filesystem read (read-only)" }
```

Built-in safe patterns cover:

- **Context7** - Documentation queries (read-only)
- **Filesystem** - Read operations only
- **Exa** - Web search (read-only, external)

### Permission Check Flow

```
Tool invocation
    ↓
Check safe patterns → Allowed (no prompt needed)
    ↓ (not in safe patterns)
Check dangerous patterns → Ask user
    ↓ (not dangerous)
Check tool capabilities → Safe caps (auto-approve) or Dangerous (ask user)
    ↓
Execute or Deny
```

### Auto-Approval Examples

```javascript
// Read-only tools are safe
checkPermission('my-plugin:search')
// { allowed: true, reason: "Tool has safe capabilities: search" }

// Write/execute requires user confirmation
checkPermission('filesystem:write_file', { path: '/etc/passwd' })
// { allowed: false, askUser: true, reason: "Tool requires explicit permission" }
```

### Caching Permissions

Permission decisions are cached. Users can grant or deny persistently:

```javascript
// User grants permission
grantPermission('custom:dangerous-tool', { mode: 'aggressive' });

// Later calls use cached decision
checkPermission('custom:dangerous-tool', { mode: 'aggressive' });
// { allowed: true, reason: "User granted permission" }

// Clear cache when needed
clearPermissionCache();
```

### Registering Safe Patterns

Plugins can register safe patterns in manifest:

```json
{
  "name": "my-plugin",
  "permissions": [
    {
      "tool": "my-plugin:query-docs",
      "scope": "read",
      "patterns": [".*"],
      "reason": "Documentation lookup is read-only"
    }
  ]
}
```

These are automatically integrated when the plugin is initialized.

## MCP Bridge

### Connecting to Servers

```javascript
import { getMcpBridge } from './compatibility';

const bridge = getMcpBridge();

// Connect to a single server
const tools = await bridge.connect('filesystem');
console.log(`Connected. Available tools: ${tools.map(t => t.name).join(', ')}`);

// Auto-connect all enabled servers
const results = await bridge.autoConnect();
for (const [serverName, tools] of results) {
  console.log(`${serverName}: ${tools.length} tools`);
}
```

### Invoking Tools

```javascript
// Invoke a tool on an MCP server
const result = await bridge.invokeTool('filesystem', 'read_file', {
  path: '/home/user/.bashrc'
});

if (result.success) {
  console.log('File contents:', result.data);
  console.log('Time:', result.executionTime, 'ms');
} else {
  console.error('Error:', result.error);
}
```

### Reading Resources

Some MCP servers provide resources (documents, APIs, etc.):

```javascript
// Read a resource
const result = await bridge.readResource('web', 'https://example.com');

if (result.success) {
  console.log(result.data);
}
```

### Connection Management

```javascript
// Check connection status
if (bridge.isConnected('filesystem')) {
  console.log('Connected to filesystem server');
}

// Get all server tools and resources
const tools = bridge.getServerTools('filesystem');
const resources = bridge.getServerResources('web');

// Disconnect from server
bridge.disconnect('filesystem');

// Disconnect from all servers
bridge.disconnectAll();
```

### Events

Monitor bridge activity:

```javascript
const bridge = getMcpBridge();

bridge.on('server-connected', ({ server, toolCount }) => {
  console.log(`Connected to ${server} with ${toolCount} tools`);
});

bridge.on('server-disconnected', ({ server, code }) => {
  console.log(`Disconnected from ${server}`);
});

bridge.on('server-error', ({ server, error }) => {
  console.error(`Error from ${server}:`, error);
});
```

## API Reference

### Initialization

```typescript
import {
  initializeCompatibility,
  getRegistry,
  getMcpBridge
} from './compatibility';

// Initialize everything
const result = await initializeCompatibility({
  pluginPaths: ['~/.claude/plugins'],
  mcpConfigPath: '~/.claude/claude_desktop_config.json',
  autoConnect: true  // Auto-connect to MCP servers
});

console.log(`Plugins: ${result.pluginCount}`);
console.log(`MCP servers: ${result.mcpServerCount}`);
console.log(`Tools: ${result.toolCount}`);
console.log(`Connected: ${result.connectedServers.join(', ')}`);
```

### Discovery Functions

```typescript
import {
  discoverPlugins,
  discoverMcpServers,
  discoverAll,
  isPluginInstalled,
  getPluginInfo,
  getPluginPaths,
  getMcpConfigPath
} from './compatibility';

// Discover plugins from custom paths
const plugins = discoverPlugins({
  pluginPaths: ['/custom/plugins/path']
});

// Discover MCP servers
const servers = discoverMcpServers({
  mcpConfigPath: '~/.claude/claude_desktop_config.json',
  settingsPath: '~/.claude/settings.json'
});

// Discover everything at once
const result = discoverAll({
  force: true  // Force re-discovery even if cached
});

// Check plugin installation
if (isPluginInstalled('my-plugin')) {
  const info = getPluginInfo('my-plugin');
  console.log(`${info.name} v${info.version}`);
}

// Get configured paths
const pluginPaths = getPluginPaths();
const mcpPath = getMcpConfigPath();
```

### Registry Functions

```typescript
import {
  getRegistry,
  initializeRegistry,
  routeCommand,
  getExternalTool,
  listExternalTools,
  hasExternalPlugins,
  hasMcpServers
} from './compatibility';

const registry = getRegistry();

// Register discovery and tools
await initializeRegistry({ force: true });

// Access tools
const allTools = listExternalTools();
const tool = getExternalTool('my-plugin:search');

// Route command
const route = routeCommand('search');
if (route) {
  console.log(`Handler: ${route.handler}`);
  console.log(`Requires permission: ${route.requiresPermission}`);
}

// Check what's available
if (hasExternalPlugins()) {
  console.log('External plugins available');
}
if (hasMcpServers()) {
  console.log('MCP servers available');
}

// Get all plugins and servers
const plugins = registry.getAllPlugins();
const servers = registry.getAllMcpServers();

// Search tools
const results = registry.searchTools('filesystem');

// Listen to events
registry.addEventListener(event => {
  if (event.type === 'tool-registered') {
    console.log(`Registered: ${event.data.tool}`);
  }
});
```

### Permission Functions

```typescript
import {
  checkPermission,
  grantPermission,
  denyPermission,
  clearPermissionCache,
  addSafePattern,
  getSafePatterns,
  shouldDelegate,
  getDelegationTarget,
  integrateWithPermissionSystem,
  processExternalToolPermission
} from './compatibility';

// Check if tool is allowed
const check = checkPermission('my-tool:dangerous-op');
if (check.allowed) {
  console.log('Allowed:', check.reason);
} else if (check.askUser) {
  console.log('Ask user:', check.reason);
}

// Cache user decisions
grantPermission('custom:tool', { mode: 'aggressive' });
denyPermission('risky:tool');
clearPermissionCache();

// Manage safe patterns
const patterns = getSafePatterns();
addSafePattern({
  tool: 'my-safe-tool',
  pattern: /^\/safe\/path/,
  description: 'Only allows /safe/path',
  source: 'myapp'
});

// Check if tool should be delegated
if (shouldDelegate('external:tool')) {
  const target = getDelegationTarget('external:tool');
  console.log(`Delegate to: ${target.type}/${target.target}`);
}

// Integrate with permission system at startup
integrateWithPermissionSystem();
```

### MCP Bridge Functions

```typescript
import {
  getMcpBridge,
  resetMcpBridge,
  invokeMcpTool,
  readMcpResource
} from './compatibility';

const bridge = getMcpBridge();

// Connect to server
const tools = await bridge.connect('filesystem');

// Invoke tool
const result = await invokeMcpTool('filesystem', 'read_file', {
  path: '/etc/hosts'
});

// Read resource
const resourceResult = await readMcpResource('web', 'https://api.example.com');

// Check connections
const status = bridge.getConnectionStatus();

// Clean up
bridge.disconnectAll();
resetMcpBridge();
```

## Examples

### Example 1: Initialize and List Tools

```javascript
import { initializeCompatibility, getRegistry } from './compatibility';

async function listAvailableTools() {
  // Initialize the compatibility layer
  const result = await initializeCompatibility({
    autoConnect: true
  });

  console.log(`Discovered ${result.pluginCount} plugins`);
  console.log(`Connected to ${result.connectedServers.length} MCP servers`);

  // List all available tools
  const registry = getRegistry();
  const tools = registry.getAllTools();

  console.log('\nAvailable tools:');
  for (const tool of tools) {
    console.log(`  ${tool.name} (${tool.type})`);
    console.log(`    Description: ${tool.description}`);
    console.log(`    Capabilities: ${tool.capabilities?.join(', ')}`);
  }
}

listAvailableTools().catch(console.error);
```

### Example 2: Search and Use a Tool

```javascript
import {
  initializeCompatibility,
  getRegistry,
  checkPermission,
  getMcpBridge
} from './compatibility';

async function searchAndRead() {
  await initializeCompatibility();

  const registry = getRegistry();

  // Search for filesystem tools
  const fileTools = registry.searchTools('filesystem');
  console.log(`Found ${fileTools.length} filesystem tools`);

  // Find read_file tool
  const readTool = fileTools.find(t => t.name.includes('read'));

  if (readTool) {
    // Check permission
    const perm = checkPermission(readTool.name);

    if (perm.allowed) {
      const bridge = getMcpBridge();
      const result = await bridge.invokeTool(
        readTool.source,
        'read_file',
        { path: '/etc/hosts' }
      );

      if (result.success) {
        console.log('File contents:', result.data);
      }
    }
  }
}

searchAndRead().catch(console.error);
```

### Example 3: Handle Plugin with MCP Server

```javascript
import {
  discoverPlugins,
  initializeRegistry,
  getMcpBridge
} from './compatibility';

async function setupPluginMcp() {
  // Discover plugins (includes MCP servers defined in manifests)
  const plugins = discoverPlugins();
  const pluginWithMcp = plugins.find(p => p.manifest.mcpServers);

  if (pluginWithMcp) {
    console.log(`Plugin ${pluginWithMcp.name} has embedded MCP servers:`);
    for (const serverName of Object.keys(pluginWithMcp.manifest.mcpServers || {})) {
      console.log(`  - ${serverName}`);
    }

    // Initialize registry (registers MCP servers from plugins)
    await initializeRegistry();

    // Connect to plugin's MCP server
    const bridge = getMcpBridge();
    const fullServerName = `${pluginWithMcp.name}:${serverName}`;

    try {
      const tools = await bridge.connect(fullServerName);
      console.log(`Connected to ${fullServerName} with ${tools.length} tools`);
    } catch (err) {
      console.error('Failed to connect:', err.message);
    }
  }
}

setupPluginMcp().catch(console.error);
```

### Example 4: Conflict Resolution

```javascript
import { getRegistry } from './compatibility';

function showConflicts() {
  const registry = getRegistry();
  const conflicts = registry.getConflicts();

  if (conflicts.length === 0) {
    console.log('No tool conflicts');
    return;
  }

  console.log(`Found ${conflicts.length} conflicts:\n`);

  for (const conflict of conflicts) {
    console.log(`Tool: ${conflict.name}`);
    console.log(`  Winner: ${conflict.winner.source} (priority: ${conflict.winner.priority})`);
    console.log('  Alternatives:');
    for (const tool of conflict.tools) {
      if (tool !== conflict.winner) {
        console.log(`    - ${tool.source} (priority: ${tool.priority})`);
      }
    }
    console.log();
  }
}

showConflicts();
```

### Example 5: Custom Permission Pattern

```javascript
import {
  addSafePattern,
  checkPermission,
  getSafePatterns
} from './compatibility';

function registerCustomPatterns() {
  // Register a safe pattern for a plugin tool
  addSafePattern({
    tool: 'analytics:track',
    pattern: /^(page_view|event|error)$/,
    description: 'Only allows tracking specific event types',
    source: 'myapp'
  });

  // Now check permission with valid input
  let result = checkPermission('analytics:track');
  console.log('Safe:', result.allowed);  // true

  // View all patterns
  const patterns = getSafePatterns();
  const myPatterns = patterns.filter(p => p.source === 'myapp');
  console.log('My patterns:', myPatterns.length);
}

registerCustomPatterns();
```

## Troubleshooting

### Plugins Not Discovered

**Problem:** `discoverPlugins()` returns empty array.

**Checklist:**
- Plugins are in `~/.claude/plugins/` or `~/.claude/installed-plugins/`
- Each plugin has a `plugin.json` in the root or `.claude-plugin/` subdirectory
- Plugin name doesn't conflict with reserved names (e.g., 'oh-my-claudecode')
- File permissions allow reading the directory

**Debug:**
```javascript
import { getPluginPaths } from './compatibility';

const paths = getPluginPaths();
console.log('Scanning paths:', paths);

// Check if directory exists
import { existsSync } from 'fs';
for (const path of paths) {
  console.log(`${path}: ${existsSync(path) ? 'exists' : 'missing'}`);
}
```

### MCP Server Won't Connect

**Problem:** `bridge.connect()` times out.

**Checklist:**
- Server command is correct (e.g., `npx`, `node`)
- Command is executable and in PATH
- Arguments are valid
- Server implements MCP protocol (JSON-RPC 2.0)
- Check stderr output for errors

**Debug:**
```javascript
import { getMcpBridge } from './compatibility';

const bridge = getMcpBridge();

bridge.on('server-error', ({ server, error }) => {
  console.error(`Server error from ${server}:`, error);
});

bridge.on('connect-error', ({ server, error }) => {
  console.error(`Failed to connect to ${server}:`, error);
});
```

### Tools Not Showing Up

**Problem:** Registered tools don't appear in `getRegistry().getAllTools()`.

**Causes and solutions:**
- Plugin not discovered - Check plugin discovery first
- Tools not extracted - Ensure SKILL.md files exist in skills directory
- Namespace conflict - Two plugins with same namespace
- Tool registration failed - Check registry events for errors

**Debug:**
```javascript
import { getRegistry, discoverPlugins } from './compatibility';

const plugins = discoverPlugins();
for (const plugin of plugins) {
  console.log(`${plugin.name}: ${plugin.tools.length} tools`);
  for (const tool of plugin.tools) {
    console.log(`  - ${tool.name}`);
  }
}

// Check what's actually registered
const registry = getRegistry();
const registered = registry.getAllTools();
console.log(`Registry has ${registered.length} tools`);

// Listen for registration events
registry.addEventListener(event => {
  if (event.type === 'tool-registered') {
    console.log('Registered:', event.data.tool);
  } else if (event.type === 'tool-conflict') {
    console.log('Conflict:', event.data.name, '→', event.data.winner);
  }
});
```

### Permission Always Denied

**Problem:** Tools requiring permission always get denied even after user approval.

**Solutions:**
- Clear permission cache: `clearPermissionCache()`
- Ensure you're using same tool name/input for cached decision
- Check if tool matches a dangerous pattern that overrides caching

**Debug:**
```javascript
import {
  checkPermission,
  grantPermission,
  getSafePatterns
} from './compatibility';

// Check if tool is in dangerous patterns
const patterns = getSafePatterns();
console.log('Safe patterns:', patterns.length);

// Manually grant
grantPermission('my-tool');

// Verify it's cached
const result = checkPermission('my-tool');
console.log('Allowed:', result.allowed);
console.log('Reason:', result.reason);
```

### Manifest Parse Errors

**Problem:** Plugin loads but manifest parsing fails.

**Checklist:**
- `plugin.json` is valid JSON (use `npm install -g jsonlint` to validate)
- Required fields present: `name`, `version`
- No syntax errors in paths or configs
- File encoding is UTF-8

**Debug:**
```javascript
import { getPluginInfo } from './compatibility';

const plugin = getPluginInfo('my-plugin');
if (plugin && !plugin.loaded) {
  console.error('Failed to load:', plugin.error);
  console.log('Manifest:', plugin.manifest);
}
```

### MCP Tool Invocation Fails

**Problem:** Tool invocation returns error.

**Debug:**
```javascript
import { getMcpBridge } from './compatibility';

const bridge = getMcpBridge();

// Check connection
console.log('Connected:', bridge.isConnected('myserver'));

// Get available tools
const tools = bridge.getServerTools('myserver');
console.log('Available tools:', tools.map(t => t.name));

// Try invocation with error details
const result = await bridge.invokeTool('myserver', 'tool-name', {});
if (!result.success) {
  console.error('Error:', result.error);
  console.error('Time:', result.executionTime, 'ms');
}
```

## Best Practices

1. **Initialize early** - Call `initializeCompatibility()` on startup
2. **Cache registry** - Reuse `getRegistry()` instance, don't repeatedly initialize
3. **Handle permissions gracefully** - Always check `checkPermission()` before invoking dangerous tools
4. **Monitor events** - Use event listeners to track plugin/server status changes
5. **Version check** - Include version constraints in plugin manifests for compatibility
6. **Test plugins locally** - Before publishing, test with local discovery paths
7. **Use namespaces** - Set `namespace` in manifest to avoid conflicts
8. **Document permissions** - Clearly explain why plugins need specific scopes
9. **Handle errors** - MCP connections can fail; implement retry logic
10. **Clean up** - Call `disconnectAll()` and `resetMcpBridge()` on shutdown
