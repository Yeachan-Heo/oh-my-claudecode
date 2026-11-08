/**
 * Prompt SSOT manifest — epic #3698 / issue #3704.
 *
 * The manifest declares section order constraints, required sections, the
 * projection catalog, and rollback history. Build fails (via
 * scripts/build-prompt-ssot.mts --check) when a committed projection's digest
 * no longer matches composition from this manifest.
 */
export const PROMPT_SSOT_MANIFEST = {
    schemaVersion: 1,
    sourceRevision: '2026-08-13.1',
    requiredSections: ['policy/operating-principles', 'safety/hard-boundaries'],
    projections: [
        {
            id: 'coordinator',
            description: 'Coordinator (CLAUDE.md-style) system prompt projection',
            sections: [
                'policy/operating-principles',
                'policy/delegation-rules',
                'policy/model-routing',
                'task-contract/verification',
                'task-contract/execution-protocols',
                'safety/hard-boundaries',
                'safety/no-release-mutation',
                'policy/commit-protocol',
                'policy/cancellation',
                'workflow/deep-interview',
                'workflow/ralplan',
                'output/evidence-contract',
            ],
            acceptsOverlays: true,
        },
        ...['planner', 'executor', 'reviewer', 'verifier'].map((role) => ({
            id: `role-${role}`,
            description: `Tier-0 role prompt projection: ${role}`,
            sections: [
                'policy/operating-principles',
                'task-contract/verification',
                'task-contract/execution-protocols',
                'safety/hard-boundaries',
                `role/${role}`,
                'output/evidence-contract',
            ],
            acceptsOverlays: true,
        })),
    ],
    rollbackHistory: [],
};
export function getProjectionSpec(id) {
    return PROMPT_SSOT_MANIFEST.projections.find((p) => p.id === id);
}
//# sourceMappingURL=manifest.js.map