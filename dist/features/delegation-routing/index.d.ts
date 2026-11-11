/**
 * Delegation Routing
 *
 * Unified delegation router that determines which provider/tool
 * to use for a given agent role based on configuration.
 */
export { resolveDelegation, parseFallbackChain, isDeprecatedMcpProvider, DEPRECATED_MCP_PROVIDER_WARNING, } from './resolver.js';
export { DEFAULT_DELEGATION_CONFIG, ROLE_CATEGORY_DEFAULTS, isDelegationEnabled, } from './types.js';
export type { DelegationProvider, DelegationTool, DelegationRoute, DelegationRoutingConfig, DelegationDecision, ResolveDelegationOptions, } from '../../shared/types.js';
//# sourceMappingURL=index.d.ts.map