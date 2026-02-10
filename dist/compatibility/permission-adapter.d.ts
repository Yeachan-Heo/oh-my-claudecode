/**
 * Permission Adapter for External Tools
 *
 * Integrates external plugins and MCP tools with OMC's permission system.
 * Provides:
 * - Safe command pattern registration from plugins
 * - Permission inheritance for known-safe tools
 * - Delegation-aware routing to avoid conflicts
 */
import type { PermissionCheckResult, SafeCommandPattern, DiscoveredPlugin } from './types.js';
/**
 * Security Error for permission adapter operations
 */
export declare class PermissionSecurityError extends Error {
    constructor(message: string);
}
/**
 * Register safe patterns from a plugin
 */
export declare function registerPluginSafePatterns(plugin: DiscoveredPlugin): void;
/**
 * Check if a tool/action is allowed without prompting user
 */
export declare function checkPermission(toolName: string, input?: Record<string, unknown>): PermissionCheckResult;
/**
 * Grant permission for a tool (cache the decision)
 */
export declare function grantPermission(toolName: string, input?: Record<string, unknown>): void;
/**
 * Deny permission for a tool (cache the decision)
 */
export declare function denyPermission(toolName: string, input?: Record<string, unknown>): void;
/**
 * Clear permission cache
 */
export declare function clearPermissionCache(): void;
/**
 * Get all registered safe patterns
 */
export declare function getSafePatterns(): SafeCommandPattern[];
/**
 * Add a custom safe pattern
 */
export declare function addSafePattern(pattern: SafeCommandPattern): void;
/**
 * Remove safe patterns from a specific source
 */
export declare function removeSafePatternsFromSource(source: string): void;
/**
 * Check if tool should be delegated (not handled directly by OMC)
 */
export declare function shouldDelegate(toolName: string): boolean;
/**
 * Get delegation target for a tool
 */
export declare function getDelegationTarget(toolName: string): {
    type: 'plugin' | 'mcp' | 'internal';
    target: string;
} | null;
/**
 * Integrate permission adapter with OMC's permission system
 * Call this during initialization to register patterns from discovered plugins
 */
export declare function integrateWithPermissionSystem(): void;
/**
 * Process a permission request from hook system
 * Returns hook-compatible output
 */
export declare function processExternalToolPermission(toolName: string, toolInput?: Record<string, unknown>): {
    continue: boolean;
    hookSpecificOutput?: {
        hookEventName: string;
        decision: {
            behavior: 'allow' | 'deny' | 'ask';
            reason?: string;
        };
    };
};
//# sourceMappingURL=permission-adapter.d.ts.map