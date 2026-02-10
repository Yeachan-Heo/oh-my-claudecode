/**
 * Delegation Routing Types
 *
 * Re-exports from shared types for convenience plus
 * delegation-specific constants and helpers.
 */

import type { DelegationRoutingConfig } from '../../shared/types.js';

export type {
  DelegationProvider,
  DelegationTool,
  DelegationRoute,
  DelegationRoutingConfig,
  DelegationDecision,
  ResolveDelegationOptions,
} from '../../shared/types.js';

/**
 * Default delegation routing configuration
 */
export const DEFAULT_DELEGATION_CONFIG: DelegationRoutingConfig = {
  enabled: false,
  defaultProvider: 'claude',
  roles: {},
};

/**
 * Role category to default Claude subagent mapping
 */
export const ROLE_CATEGORY_DEFAULTS: Record<string, string> = {
  // Exploration roles
  explore: 'explore',
  researcher: 'researcher',

  // Advisory roles (high complexity)
  architect: 'architect',
  planner: 'planner',
  critic: 'critic',
  analyst: 'analyst',

  // Implementation roles
  executor: 'executor',
  'deep-executor': 'deep-executor',

  // Review roles
  'code-reviewer': 'code-reviewer',
  'security-reviewer': 'security-reviewer',
  'quality-reviewer': 'quality-reviewer',

  // Specialized roles
  designer: 'designer',
  writer: 'writer',
  vision: 'vision',
  'qa-tester': 'qa-tester',
  debugger: 'debugger',
  scientist: 'scientist',
  'build-fixer': 'build-fixer',
};

/**
 * Check if delegation routing is enabled
 */
export function isDelegationEnabled(
  config: DelegationRoutingConfig | undefined
): boolean {
  return config?.enabled === true;
}
