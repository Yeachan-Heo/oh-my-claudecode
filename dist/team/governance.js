export const DEFAULT_TEAM_TRANSPORT_POLICY = {
    display_mode: 'split_pane',
    worker_launch_mode: 'interactive',
    dispatch_mode: 'hook_preferred_with_fallback',
    dispatch_ack_timeout_ms: 15_000,
};
export const DEFAULT_TEAM_GOVERNANCE = {
    delegation_only: false,
    plan_approval_required: false,
    nested_teams_allowed: false,
    one_team_per_leader_session: true,
    cleanup_requires_all_workers_inactive: true,
};
export function normalizeTeamTransportPolicy(policy) {
    return {
        display_mode: policy?.display_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.display_mode,
        worker_launch_mode: policy?.worker_launch_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.worker_launch_mode,
        dispatch_mode: policy?.dispatch_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode,
        dispatch_ack_timeout_ms: typeof policy?.dispatch_ack_timeout_ms === 'number'
            ? policy.dispatch_ack_timeout_ms
            : DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_ack_timeout_ms,
    };
}
export function normalizeTeamGovernance(governance, legacyPolicy) {
    return {
        delegation_only: governance?.delegation_only
            ?? legacyPolicy?.delegation_only
            ?? DEFAULT_TEAM_GOVERNANCE.delegation_only,
        plan_approval_required: governance?.plan_approval_required
            ?? legacyPolicy?.plan_approval_required
            ?? DEFAULT_TEAM_GOVERNANCE.plan_approval_required,
        nested_teams_allowed: governance?.nested_teams_allowed
            ?? legacyPolicy?.nested_teams_allowed
            ?? DEFAULT_TEAM_GOVERNANCE.nested_teams_allowed,
        one_team_per_leader_session: governance?.one_team_per_leader_session
            ?? legacyPolicy?.one_team_per_leader_session
            ?? DEFAULT_TEAM_GOVERNANCE.one_team_per_leader_session,
        cleanup_requires_all_workers_inactive: governance?.cleanup_requires_all_workers_inactive
            ?? legacyPolicy?.cleanup_requires_all_workers_inactive
            ?? DEFAULT_TEAM_GOVERNANCE.cleanup_requires_all_workers_inactive,
    };
}
export function normalizeTeamManifest(manifest) {
    return {
        ...manifest,
        policy: normalizeTeamTransportPolicy(manifest.policy),
        governance: normalizeTeamGovernance(manifest.governance, manifest.policy),
    };
}
export function getConfigGovernance(config) {
    return normalizeTeamGovernance(config?.governance, config?.policy);
}
//# sourceMappingURL=governance.js.map