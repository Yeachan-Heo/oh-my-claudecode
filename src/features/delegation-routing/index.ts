/**
 * Delegation Routing
 *
 * Unified delegation router that determines which provider/tool
 * to use for a given agent role based on configuration.
 */

// Main resolver
export { resolveDelegation, parseFallbackChain } from './resolver.js';

// Types and constants
export {
  DEFAULT_DELEGATION_CONFIG,
  ROLE_CATEGORY_DEFAULTS,
  isDelegationEnabled,
} from './types.js';

// Re-export shared types for convenience
export type {
  DelegationProvider,
  DelegationTool,
  DelegationRoute,
  DelegationRoutingConfig,
  DelegationDecision,
  ResolveDelegationOptions,
} from '../../shared/types.js';
