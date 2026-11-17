/**
 * Canonical prompt sections for epic #3698 / issue #3704.
 *
 * Every normative clause below is authored EXACTLY ONCE here. Legacy
 * projections (CLAUDE.md, docs/CLAUDE.md, .github/CLAUDE.md, agents/*.md)
 * previously repeated these clauses as copied prose; they are superseded by
 * deterministic projections of this source (see manifest.ts / compose.ts).
 *
 * Authoring rules:
 * - One owner per section; one normative clause set per id.
 * - Provider/model differences belong in provider-delta / model-tier-delta
 *   sections, never as copied policy paragraphs in a base section.
 * - Bump `version` and the manifest `sourceRevision` on any body change.
 */
import type { PromptSection } from './types.js';
export declare const PROMPT_SECTIONS: readonly PromptSection[];
export declare function getSection(id: string): PromptSection | undefined;
//# sourceMappingURL=sections.d.ts.map