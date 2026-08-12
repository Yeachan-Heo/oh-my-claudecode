/**
 * Workflow public surface for issue #3706
 * Barrel re-exports the alias resolver seam. When #3703 lands, this
 * barrel re-exports the canonical registry as well and the alias-resolver
 * adapts via `resolveWorkflowAliasViaRegistry`.
 */
export * from './alias-resolver.js';
