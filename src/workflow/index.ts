/**
 * Workflow public surface.
 *
 * - alias-resolver: merged #3706 resolver (Tier-0 contract, alias routing,
 *   once-per-session warnings, telemetry/receipts, retirement verifier).
 * - registry / projections: #3703 canonical workflow registry, compatibility
 *   policy, risk classes, Tier-0 roles, deterministic projection + drift check.
 */
export * from './alias-resolver.js';
export * from './registry.js';
export * from './projections.js';
