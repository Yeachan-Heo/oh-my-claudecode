/**
 * Prompt SSOT (single source of truth) types — epic #3698 / issue #3704.
 *
 * Canonical normative prompt text lives exactly once as structured sections.
 * Every consumer surface (coordinator prompts, role prompts, CLAUDE.md
 * projections, command/skill guidance) is a deterministic projection of the
 * manifest plus optional provider/model-tier overlays. Provider and model
 * differences are data (delta sections), never copied policy paragraphs.
 */
export type SectionKind = 'policy' | 'task-contract' | 'safety' | 'role-delta' | 'workflow-delta' | 'provider-delta' | 'model-tier-delta' | 'output-contract';
/**
 * Deterministic render rank. Sections selected for a projection are sorted by
 * (rank, manifest order) so composition never depends on selection order.
 */
export declare const SECTION_KIND_RANK: Record<SectionKind, number>;
export interface PromptSection {
    /** Stable kebab-case identifier, e.g. `policy/commit-protocol`. */
    id: string;
    kind: SectionKind;
    /** Single accountable owner for this normative clause (plan §6.2). */
    owner: string;
    /** Bump when the body changes; digests bind id+version+body. */
    version: number;
    /** Canonical normalized-markdown body. Authored exactly once. */
    body: string;
}
export type ProviderId = 'claude' | 'codex' | 'gemini' | 'antigravity';
export type ModelTier = 'low' | 'medium' | 'high';
export interface ComposeOverlay {
    provider?: ProviderId;
    modelTier?: ModelTier;
}
export interface ProjectionSpec {
    /** Stable projection identifier, e.g. `role-executor`. */
    id: string;
    /** Human-facing description of the consumer surface. */
    description: string;
    /** Base section ids (non-overlay kinds), in any order; rank sorts them. */
    sections: string[];
    /** Overlay kinds this projection accepts. */
    acceptsOverlays: boolean;
}
export interface RollbackEntry {
    sourceRevision: string;
    digest: string;
    retiredAt: string;
}
export interface PromptSsotManifest {
    schemaVersion: 1;
    /** Monotonic source stamp, e.g. `2026-08-12.1`. Bumped on section edits. */
    sourceRevision: string;
    /** Section ids that every projection must include. */
    requiredSections: string[];
    projections: ProjectionSpec[];
    /**
     * Prior manifest projections for rollback (issue contract). Rollback
     * selects a prior entry and regenerates projections from the recorded
     * revision/digest.
     */
    rollbackHistory: RollbackEntry[];
}
export interface ProjectionMetadata {
    schemaVersion: 1;
    sourceRevision: string;
    digest: string;
    overlay: ComposeOverlay;
    sectionDigests: Record<string, string>;
}
export interface ComposedProjection {
    id: string;
    metadata: ProjectionMetadata;
    /** Body only (no metadata header). Digests are computed over this. */
    body: string;
    /** Full serialized file text including the metadata header. */
    fileText: string;
}
//# sourceMappingURL=types.d.ts.map