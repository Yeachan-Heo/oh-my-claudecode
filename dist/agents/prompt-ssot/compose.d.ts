/**
 * Deterministic prompt SSOT composer — epic #3698 / issue #3704.
 *
 * composeProjection(manifest, sections, projectionId, overlay) renders one
 * projection. Given the same manifest + sections + overlay the output text
 * and digest are byte-identical: sections are selected, sorted by
 * (kind rank, manifest-declared order), joined with a single blank line,
 * normalized, and hashed. Overlay sections (provider-delta matching
 * overlay.provider, model-tier-delta matching overlay.modelTier) are data
 * selects, not copied prose.
 */
import type { ComposeOverlay, ComposedProjection, PromptSection, PromptSsotManifest } from './types.js';
export declare class PromptSsotError extends Error {
}
export declare function selectSections(manifest: PromptSsotManifest, sections: readonly PromptSection[], projectionId: string, overlay?: ComposeOverlay): PromptSection[];
export declare function composeProjection(manifest: PromptSsotManifest, sections: readonly PromptSection[], projectionId: string, overlay?: ComposeOverlay): ComposedProjection;
/** All declared projections composed with the same overlay. */
export declare function composeAll(manifest: PromptSsotManifest, sections: readonly PromptSection[], overlay?: ComposeOverlay): ComposedProjection[];
//# sourceMappingURL=compose.d.ts.map