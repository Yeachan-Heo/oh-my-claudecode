/**
 * Prompt SSOT manifest — epic #3698 / issue #3704.
 *
 * The manifest declares section order constraints, required sections, the
 * projection catalog, and rollback history. Build fails (via
 * scripts/build-prompt-ssot.mts --check) when a committed projection's digest
 * no longer matches composition from this manifest.
 */
import type { PromptSsotManifest } from './types.js';
export declare const PROMPT_SSOT_MANIFEST: PromptSsotManifest;
export declare function getProjectionSpec(id: string): import("./types.js").ProjectionSpec | undefined;
//# sourceMappingURL=manifest.d.ts.map