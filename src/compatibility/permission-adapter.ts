/**
 * Permission Adapter for External Tools
 *
 * Integrates external plugins and MCP tools with OMC's permission system.
 * Provides:
 * - Safe command pattern registration from plugins
 * - Permission inheritance for known-safe tools
 * - Delegation-aware routing to avoid conflicts
 */

import type {
  ExternalTool,
  PluginPermission,
  PermissionCheckResult,
  SafeCommandPattern,
  DiscoveredPlugin,
} from './types.js';
import { getRegistry } from './registry.js';

/**
 * Built-in safe patterns for known external tools
 */
const BUILTIN_SAFE_PATTERNS: SafeCommandPattern[] = [
  // Context7 MCP - documentation lookup (read-only)
  {
    tool: 'mcp__context7__resolve-library-id',
    pattern: /.*/,
    description: 'Context7 library resolution (read-only)',
    source: 'builtin',
  },
  {
    tool: 'mcp__context7__query-docs',
    pattern: /.*/,
    description: 'Context7 documentation query (read-only)',
    source: 'builtin',
  },
  // Filesystem MCP - read operations only
  {
    tool: 'mcp__filesystem__read_file',
    pattern: /.*/,
    description: 'Filesystem read (read-only)',
    source: 'builtin',
  },
  {
    tool: 'mcp__filesystem__read_text_file',
    pattern: /.*/,
    description: 'Filesystem text read (read-only)',
    source: 'builtin',
  },
  {
    tool: 'mcp__filesystem__list_directory',
    pattern: /.*/,
    description: 'Directory listing (read-only)',
    source: 'builtin',
  },
  {
    tool: 'mcp__filesystem__search_files',
    pattern: /.*/,
    description: 'File search (read-only)',
    source: 'builtin',
  },
  {
    tool: 'mcp__filesystem__get_file_info',
    pattern: /.*/,
    description: 'File info (read-only)',
    source: 'builtin',
  },
  {
    tool: 'mcp__filesystem__directory_tree',
    pattern: /.*/,
    description: 'Directory tree (read-only)',
    source: 'builtin',
  },
  // Exa MCP - web search (read-only, external)
  {
    tool: 'mcp__exa__search',
    pattern: /.*/,
    description: 'Exa web search (read-only)',
    source: 'builtin',
  },
];

/**
 * Patterns that require explicit permission
 */
const REQUIRES_PERMISSION_PATTERNS: RegExp[] = [
  // Filesystem write operations
  /mcp__filesystem__write/,
  /mcp__filesystem__edit/,
  /mcp__filesystem__create/,
  /mcp__filesystem__move/,
  /mcp__filesystem__delete/,
  // Playwright browser operations (can interact with external sites)
  /mcp__playwright/,
  // Any bash/command execution
  /bash/i,
  /exec/i,
  /run/i,
  /command/i,
];

/**
 * Registry of safe patterns (including plugin-contributed ones)
 */
const safePatterns: SafeCommandPattern[] = [...BUILTIN_SAFE_PATTERNS];

/**
 * Cache of permission decisions
 */
const permissionCache = new Map<string, PermissionCheckResult>();

/**
 * Register safe patterns from a plugin
 */
export function registerPluginSafePatterns(plugin: DiscoveredPlugin): void {
  if (!plugin.manifest.permissions) return;

  for (const permission of plugin.manifest.permissions) {
    if (permission.scope === 'read' && permission.patterns) {
      for (const pattern of permission.patterns) {
        safePatterns.push({
          tool: permission.tool,
          pattern: new RegExp(pattern),
          description: permission.reason || `Safe pattern from ${plugin.name}`,
          source: plugin.name,
        });
      }
    }
  }
}

/**
 * Check if a tool/action is allowed without prompting user
 */
export function checkPermission(
  toolName: string,
  input?: Record<string, unknown>
): PermissionCheckResult {
  // Check cache first
  const cacheKey = `${toolName}:${JSON.stringify(input)}`;
  const cached = permissionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Check if tool matches safe patterns
  for (const pattern of safePatterns) {
    if (toolName === pattern.tool || toolName.includes(pattern.tool)) {
      const result: PermissionCheckResult = {
        allowed: true,
        reason: pattern.description,
      };
      permissionCache.set(cacheKey, result);
      return result;
    }
  }

  // Check if tool requires explicit permission
  for (const pattern of REQUIRES_PERMISSION_PATTERNS) {
    if (pattern.test(toolName)) {
      const result: PermissionCheckResult = {
        allowed: false,
        reason: `Tool ${toolName} requires explicit permission`,
        askUser: true,
      };
      permissionCache.set(cacheKey, result);
      return result;
    }
  }

  // Check tool capabilities from registry
  const registry = getRegistry();
  const tool = registry.getTool(toolName);

  if (tool) {
    // Read-only and search tools are generally safe
    const safeCapabilities = ['read', 'search', 'analyze'];
    const isSafe = tool.capabilities?.every(c => safeCapabilities.includes(c)) ?? false;

    if (isSafe) {
      const result: PermissionCheckResult = {
        allowed: true,
        reason: `Tool ${toolName} has safe capabilities: ${tool.capabilities?.join(', ')}`,
      };
      permissionCache.set(cacheKey, result);
      return result;
    }

    // Has dangerous capabilities
    const result: PermissionCheckResult = {
      allowed: false,
      reason: `Tool ${toolName} has capabilities requiring permission: ${tool.capabilities?.join(', ')}`,
      askUser: true,
    };
    permissionCache.set(cacheKey, result);
    return result;
  }

  // Unknown tool - ask user
  return {
    allowed: false,
    reason: `Unknown tool: ${toolName}`,
    askUser: true,
  };
}

/**
 * Grant permission for a tool (cache the decision)
 */
export function grantPermission(toolName: string, input?: Record<string, unknown>): void {
  const cacheKey = `${toolName}:${JSON.stringify(input)}`;
  permissionCache.set(cacheKey, {
    allowed: true,
    reason: 'User granted permission',
  });
}

/**
 * Deny permission for a tool (cache the decision)
 */
export function denyPermission(toolName: string, input?: Record<string, unknown>): void {
  const cacheKey = `${toolName}:${JSON.stringify(input)}`;
  permissionCache.set(cacheKey, {
    allowed: false,
    reason: 'User denied permission',
  });
}

/**
 * Clear permission cache
 */
export function clearPermissionCache(): void {
  permissionCache.clear();
}

/**
 * Get all registered safe patterns
 */
export function getSafePatterns(): SafeCommandPattern[] {
  return [...safePatterns];
}

/**
 * Add a custom safe pattern
 */
export function addSafePattern(pattern: SafeCommandPattern): void {
  safePatterns.push(pattern);
}

/**
 * Remove safe patterns from a specific source
 */
export function removeSafePatternsFromSource(source: string): void {
  const toRemove = safePatterns.filter(p => p.source === source);
  for (const pattern of toRemove) {
    const index = safePatterns.indexOf(pattern);
    if (index >= 0) {
      safePatterns.splice(index, 1);
    }
  }
}

/**
 * Check if tool should be delegated (not handled directly by OMC)
 */
export function shouldDelegate(toolName: string): boolean {
  const registry = getRegistry();
  const tool = registry.getTool(toolName);

  if (!tool) {
    return false;
  }

  // External plugins should handle their own tools
  if (tool.type === 'plugin') {
    return true;
  }

  // MCP tools are handled by MCP bridge
  if (tool.type === 'mcp') {
    return true;
  }

  // Skills and agents from external plugins
  if ((tool.type === 'skill' || tool.type === 'agent') && tool.source !== 'oh-my-claudecode') {
    return true;
  }

  return false;
}

/**
 * Get delegation target for a tool
 */
export function getDelegationTarget(toolName: string): {
  type: 'plugin' | 'mcp' | 'internal';
  target: string;
} | null {
  const registry = getRegistry();
  const tool = registry.getTool(toolName);

  if (!tool) {
    return null;
  }

  if (tool.type === 'plugin' || tool.type === 'skill' || tool.type === 'agent') {
    return {
      type: 'plugin',
      target: tool.source,
    };
  }

  if (tool.type === 'mcp') {
    return {
      type: 'mcp',
      target: tool.source,
    };
  }

  return {
    type: 'internal',
    target: 'oh-my-claudecode',
  };
}

/**
 * Integrate permission adapter with OMC's permission system
 * Call this during initialization to register patterns from discovered plugins
 */
export function integrateWithPermissionSystem(): void {
  const registry = getRegistry();

  // Register safe patterns from all discovered plugins
  for (const plugin of registry.getAllPlugins()) {
    registerPluginSafePatterns(plugin);
  }

  // Register MCP tools as safe if they're read-only
  for (const server of registry.getAllMcpServers()) {
    for (const tool of server.tools) {
      if (tool.capabilities?.every(c => c === 'read' || c === 'search')) {
        safePatterns.push({
          tool: tool.name,
          pattern: /.*/,
          description: `Read-only MCP tool from ${server.name}`,
          source: server.name,
        });
      }
    }
  }
}

/**
 * Process a permission request from hook system
 * Returns hook-compatible output
 */
export function processExternalToolPermission(
  toolName: string,
  toolInput?: Record<string, unknown>
): {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    decision: {
      behavior: 'allow' | 'deny' | 'ask';
      reason?: string;
    };
  };
} {
  const result = checkPermission(toolName, toolInput);

  if (result.allowed) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          reason: result.reason,
        },
      },
    };
  }

  if (result.askUser) {
    return {
      continue: true, // Let normal permission flow handle it
    };
  }

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        reason: result.reason,
      },
    },
  };
}
