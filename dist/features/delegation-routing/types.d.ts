/**
 * Delegation Routing Types
 *
 * Re-exports from shared types for convenience plus
 * delegation-specific constants and helpers.
 */
import type { DelegationRoutingConfig } from '../../shared/types.js';
export type { DelegationProvider, DelegationTool, DelegationRoute, DelegationRoutingConfig, DelegationDecision, ResolveDelegationOptions, } from '../../shared/types.js';
/**
 * Default delegation routing configuration
 */
export declare const DEFAULT_DELEGATION_CONFIG: DelegationRoutingConfig;
/**
 * Role category to default Claude subagent mapping
 */
export declare const ROLE_CATEGORY_DEFAULTS: Record<string, string>;
/**
 * Check if delegation routing is enabled
 */
export declare function isDelegationEnabled(config: DelegationRoutingConfig | undefined): boolean;
//# sourceMappingURL=types.d.ts.map