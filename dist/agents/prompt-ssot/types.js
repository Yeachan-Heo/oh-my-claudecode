/**
 * Prompt SSOT (single source of truth) types — epic #3698 / issue #3704.
 *
 * Canonical normative prompt text lives exactly once as structured sections.
 * Every consumer surface (coordinator prompts, role prompts, CLAUDE.md
 * projections, command/skill guidance) is a deterministic projection of the
 * manifest plus optional provider/model-tier overlays. Provider and model
 * differences are data (delta sections), never copied policy paragraphs.
 */
/**
 * Deterministic render rank. Sections selected for a projection are sorted by
 * (rank, manifest order) so composition never depends on selection order.
 */
export const SECTION_KIND_RANK = {
    policy: 0,
    'task-contract': 1,
    safety: 2,
    'provider-delta': 3,
    'model-tier-delta': 4,
    'role-delta': 5,
    'workflow-delta': 6,
    'output-contract': 7,
};
//# sourceMappingURL=types.js.map