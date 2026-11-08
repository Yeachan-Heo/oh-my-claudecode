/**
 * Prompt SSOT public surface — epic #3698 / issue #3704.
 *
 * Integration seams:
 * - #3702 (inventory/graph): scripts/measure-prompt-ssot.mts emits the
 *   machine-readable metrics artifact consumed by inventory reporting.
 * - #3703 (workflow registry, merged): Tier-0 role projection ids
 *   (`role-planner|executor|reviewer|verifier`) mirror the registry's
 *   WORKFLOW_ROLES; a drift guard lives in the test suite.
 * - #3705 (projection parity/install migration) owns rewiring legacy
 *   CLAUDE.md / agents/*.md consumers onto composeProjection; this issue
 *   ships only the additive source/manifest/composer/digest/metrics surface.
 */

export * from './types.js';
export * from './digest.js';
export * from './compose.js';
export * from './metrics.js';
export { PROMPT_SECTIONS, getSection } from './sections.js';
export { PROMPT_SSOT_MANIFEST, getProjectionSpec } from './manifest.js';
