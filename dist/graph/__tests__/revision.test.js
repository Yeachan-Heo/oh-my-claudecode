import { describe, expect, it } from 'vitest';
import { canonicalJson, sealGraphDescriptor } from '../descriptor.js';
import { GraphRevisionError, approveGraphPatch, approvePendingGraphRevision, proposeGraphPatch, replacePendingDraft, } from '../revisions.js';
import { createInitialGraphState } from '../runtime-types.js';
import { forkJoinDescriptor } from './fixtures.js';
function approvedState() {
    const descriptor = sealGraphDescriptor(forkJoinDescriptor());
    return createInitialGraphState({
        session_id: 'session-revision',
        control_nonce: 'control-revision',
        descriptor,
        status: 'running',
        created_at: '2026-07-21T00:00:00.000Z',
        projection: {
            activations: {
                completed: {
                    activation_id: 'completed',
                    node_id: 'branch-a',
                    status: 'completed',
                    attempt_no: 1,
                    attempt_ids: ['attempt-a'],
                    completed_transition_id: 'transition-a',
                    traversal_owner_id: 'root',
                },
            },
            cohorts: {},
            branch_tokens: {},
            traversal_counts: {},
            committed_transitions: {},
            terminal_verification_activation_ids: [],
        },
        approval: {
            approved_at: '2026-07-21T00:00:00.000Z',
            evidence: { kind: 'human', ref: 'approval-1' },
        },
    });
}
function nextDescriptor(changeCompletedNode = false) {
    const next = forkJoinDescriptor();
    next.revision_id = 'revision-2';
    next.goal = 'Build and verify two branches with an approved patch';
    if (changeCompletedNode) {
        const node = next.nodes.find((candidate) => candidate.id === 'branch-a');
        if (node)
            node.title = 'repurposed completed work';
    }
    return sealGraphDescriptor(next);
}
describe('graph revisions', () => {
    it('replaces a rejected pending draft without making it runnable, then approves the exact replacement', () => {
        const descriptor = sealGraphDescriptor(forkJoinDescriptor());
        const pending = createInitialGraphState({
            session_id: 'session-revision',
            control_nonce: 'control-revision',
            descriptor,
            status: 'awaiting_approval',
            created_at: '2026-07-21T00:00:00.000Z',
            projection: {
                activations: {},
                cohorts: {},
                branch_tokens: {},
                traversal_counts: {},
                committed_transitions: {},
                terminal_verification_activation_ids: [],
            },
        });
        const replacement = nextDescriptor();
        const replaced = replacePendingDraft(pending, {
            descriptor: replacement,
            replaced_at: '2026-07-21T00:00:01.000Z',
        });
        expect(replaced).toMatchObject({
            status: 'awaiting_approval',
            active_revision_id: 'revision-2',
            active_revision_hash: replacement.descriptor_hash,
            pending_approval: {
                revision_id: 'revision-2',
                revision_hash: replacement.descriptor_hash,
            },
        });
        expect(replaced.projection.activations).toEqual({});
        const approved = approvePendingGraphRevision(replaced, {
            revision_id: 'revision-2',
            revision_hash: replacement.descriptor_hash,
            approved_at: '2026-07-21T00:00:02.000Z',
            approval_evidence: { kind: 'human', ref: 'approve-replacement' },
        }, (approvedDescriptor) => ({
            activations: {
                approval: {
                    activation_id: 'approval',
                    node_id: approvedDescriptor.entry_node_ids[0],
                    status: 'ready',
                    attempt_no: 0,
                    attempt_ids: [],
                    traversal_owner_id: 'root',
                },
            },
            cohorts: {},
            branch_tokens: {},
            traversal_counts: {},
            committed_transitions: {},
            terminal_verification_activation_ids: [],
        }));
        expect(approved.status).toBe('running');
        expect(approved.pending_approval).toBeUndefined();
        expect(approved.revisions['revision-2'].approval).toMatchObject({
            revision_id: 'revision-2',
            revision_hash: replacement.descriptor_hash,
        });
    });
    it('advances dispatch generation and pauses new dispatch on proposal', () => {
        const state = approvedState();
        const proposed = proposeGraphPatch(state, {
            proposal_id: 'patch-1',
            base_revision_id: state.active_revision_id,
            base_revision_hash: state.active_revision_hash,
            proposed_descriptor: nextDescriptor(),
            invalidated_node_ids: [],
            proposal_evidence: [{ kind: 'file', ref: 'patch.json' }],
            proposed_at: '2026-07-21T00:00:01.000Z',
        });
        expect(proposed.status).toBe('waiting_patch_approval');
        expect(proposed.dispatch_generation).toBe(1);
        expect(proposed.pending_patch).toMatchObject({
            proposal_id: 'patch-1',
            base_dispatch_generation: 0,
            proposed_revision_id: 'revision-2',
        });
        expect(proposed.revisions['revision-2']).toBeUndefined();
    });
    it('fences non-ambiguous live claims on patch approval and still rejects ambiguous/reconciliation', () => {
        const state = proposeGraphPatch(approvedState(), {
            proposal_id: 'patch-1',
            base_revision_id: 'revision-1',
            base_revision_hash: approvedState().active_revision_hash,
            proposed_descriptor: nextDescriptor(),
            invalidated_node_ids: [],
            proposal_evidence: [],
            proposed_at: '2026-07-21T00:00:01.000Z',
        });
        state.claims['lease-old'] = {
            run_id: state.run_id,
            revision_id: state.active_revision_id,
            revision_hash: state.active_revision_hash,
            dispatch_generation: 0,
            activation_id: 'completed',
            attempt_id: 'attempt-a',
            attempt_no: 1,
            claim_owner_session_id: state.session_id,
            driver_instance_id: 'driver',
            lease_id: 'lease-old',
            tracking_id: 'tool',
            issued_at: '2026-07-21T00:00:00.000Z',
            expires_at: '2026-07-21T00:01:00.000Z',
            lease_duration_ms: 60_000,
            renewal_count: 0,
            max_renewals: 1,
            effect_policy: { policy: 'side_effect_free' },
            status: 'live',
        };
        // WEDGE 1: a non-ambiguous (side_effect_free) live claim no longer hard-
        // rejects; it is fenced atomically with patch approval so the run does not
        // wedge while waiting for the claim to drain (which it cannot, because the
        // runtime result/release gates reject waiting_patch_approval).
        const approved = approveGraphPatch(state, {
            proposal_id: 'patch-1',
            base_revision_id: state.active_revision_id,
            base_revision_hash: state.active_revision_hash,
            proposed_revision_hash: state.pending_patch.proposed_revision_hash,
            invalidated_node_ids: [],
            approval_evidence: { kind: 'human', ref: 'approve-patch-1' },
            approved_at: '2026-07-21T00:00:02.000Z',
        }, (projection) => projection);
        expect(approved.status).toBe('running');
        expect(approved.claims['lease-old'].status).toBe('fenced');
        expect(approved.claims['lease-old'].fenced_at).toBe('2026-07-21T00:00:02.000Z');
        // An ambiguous (reconcile-policy) live claim still hard-rejects: its
        // external-effect outcome requires human resolution and must not be
        // silently dropped by a patch approval.
        const ambiguous = proposeGraphPatch(approvedState(), {
            proposal_id: 'patch-2',
            base_revision_id: 'revision-1',
            base_revision_hash: approvedState().active_revision_hash,
            proposed_descriptor: nextDescriptor(),
            invalidated_node_ids: [],
            proposal_evidence: [],
            proposed_at: '2026-07-21T00:00:01.000Z',
        });
        ambiguous.claims['lease-amb'] = {
            ...state.claims['lease-old'],
            lease_id: 'lease-amb',
            effect_policy: { policy: 'reconcile' },
            status: 'live',
        };
        expect(() => approveGraphPatch(ambiguous, {
            proposal_id: 'patch-2',
            base_revision_id: ambiguous.active_revision_id,
            base_revision_hash: ambiguous.active_revision_hash,
            proposed_revision_hash: ambiguous.pending_patch.proposed_revision_hash,
            invalidated_node_ids: [],
            approval_evidence: { kind: 'human', ref: 'approve-patch-2' },
            approved_at: '2026-07-21T00:00:02.000Z',
        }, (projection) => projection)).toThrow(/ambiguous.*reconcile-policy.*live claim/i);
        // Unresolved reconciliation still blocks.
        ambiguous.claims['lease-amb'].status = 'reconciling';
        ambiguous.claims['lease-amb'].fenced_at = '2026-07-21T00:00:01.500Z';
        ambiguous.reconciliations['reconciliation-old'] = {
            reconciliation_id: 'reconciliation-old',
            activation_id: 'completed',
            attempt_id: 'attempt-a',
            lease_id: 'lease-amb',
            revision_id: ambiguous.active_revision_id,
            revision_hash: ambiguous.active_revision_hash,
            dispatch_generation: 0,
            status: 'unresolved',
            reason: 'external_effect_ambiguous',
            created_at: '2026-07-21T00:00:01.500Z',
        };
        expect(() => approveGraphPatch(ambiguous, {
            proposal_id: 'patch-2',
            base_revision_id: ambiguous.active_revision_id,
            base_revision_hash: ambiguous.active_revision_hash,
            proposed_revision_hash: ambiguous.pending_patch.proposed_revision_hash,
            invalidated_node_ids: [],
            approval_evidence: { kind: 'human', ref: 'approve-patch-2' },
            approved_at: '2026-07-21T00:00:02.000Z',
        }, (projection) => projection)).toThrow(/unresolved reconciliation/i);
    });
    it('resets a fenced live claim activation to ready so it is re-claimable under the new revision', () => {
        // WEDGE 1: the activation bound to a fenced live claim must return to
        // 'ready' (active attempt dropped) so the scheduler can re-claim it under
        // the approved revision; otherwise the work is silently lost.
        const base = approvedState();
        // Add a running activation bound to a live claim that will be fenced.
        base.projection.activations['running'] = {
            activation_id: 'running',
            node_id: 'branch-a',
            status: 'running',
            attempt_no: 1,
            attempt_ids: ['attempt-running'],
            active_attempt_id: 'attempt-running',
            traversal_owner_id: 'root',
        };
        const state = proposeGraphPatch(base, {
            proposal_id: 'patch-1',
            base_revision_id: base.active_revision_id,
            base_revision_hash: base.active_revision_hash,
            proposed_descriptor: nextDescriptor(),
            invalidated_node_ids: [],
            proposal_evidence: [],
            proposed_at: '2026-07-21T00:00:01.000Z',
        });
        state.claims['lease-running'] = {
            run_id: state.run_id,
            revision_id: state.active_revision_id,
            revision_hash: state.active_revision_hash,
            dispatch_generation: 0,
            activation_id: 'running',
            attempt_id: 'attempt-running',
            attempt_no: 1,
            claim_owner_session_id: state.session_id,
            driver_instance_id: 'driver',
            lease_id: 'lease-running',
            tracking_id: 'tool',
            issued_at: '2026-07-21T00:00:00.000Z',
            expires_at: '2026-07-21T00:01:00.000Z',
            lease_duration_ms: 60_000,
            renewal_count: 0,
            max_renewals: 1,
            effect_policy: { policy: 'side_effect_free' },
            status: 'live',
        };
        const approved = approveGraphPatch(state, {
            proposal_id: 'patch-1',
            base_revision_id: state.active_revision_id,
            base_revision_hash: state.active_revision_hash,
            proposed_revision_hash: state.pending_patch.proposed_revision_hash,
            invalidated_node_ids: [],
            approval_evidence: { kind: 'human', ref: 'approve-patch-1' },
            approved_at: '2026-07-21T00:00:02.000Z',
        }, (projection) => projection);
        expect(approved.claims['lease-running'].status).toBe('fenced');
        const settled = approved.projection.activations['running'];
        expect(settled.status).toBe('ready');
        expect(settled.active_attempt_id).toBeUndefined();
    });
    it('keeps stale-base and unapproved patch proposals inert', () => {
        const state = approvedState();
        const before = canonicalJson(state);
        expect(() => proposeGraphPatch(state, {
            proposal_id: 'patch-stale',
            base_revision_id: state.active_revision_id,
            base_revision_hash: '0'.repeat(64),
            proposed_descriptor: nextDescriptor(),
            invalidated_node_ids: [],
            proposal_evidence: [],
            proposed_at: '2026-07-21T00:00:01.000Z',
        })).toThrow(/stale base/i);
        expect(canonicalJson(state)).toBe(before);
        expect(state.revisions['revision-2']).toBeUndefined();
    });
    it('rejects silent repurposing of a completed node ID', () => {
        const state = approvedState();
        const proposed = proposeGraphPatch(state, {
            proposal_id: 'patch-1',
            base_revision_id: state.active_revision_id,
            base_revision_hash: state.active_revision_hash,
            proposed_descriptor: nextDescriptor(true),
            invalidated_node_ids: [],
            proposal_evidence: [],
            proposed_at: '2026-07-21T00:00:01.000Z',
        });
        expect(() => approveGraphPatch(proposed, {
            proposal_id: 'patch-1',
            base_revision_id: state.active_revision_id,
            base_revision_hash: state.active_revision_hash,
            proposed_revision_hash: proposed.pending_patch.proposed_revision_hash,
            invalidated_node_ids: [],
            approval_evidence: { kind: 'human', ref: 'approve-patch-1' },
            approved_at: '2026-07-21T00:00:02.000Z',
        }, (projection) => projection)).toThrowError(GraphRevisionError);
    });
    it('activates an immutable approved revision only with explicit invalidation evidence', () => {
        const state = approvedState();
        const descriptor = nextDescriptor(true);
        const proposed = proposeGraphPatch(state, {
            proposal_id: 'patch-1',
            base_revision_id: state.active_revision_id,
            base_revision_hash: state.active_revision_hash,
            proposed_descriptor: descriptor,
            invalidated_node_ids: ['branch-a'],
            proposal_evidence: [],
            proposed_at: '2026-07-21T00:00:01.000Z',
        });
        const approved = approveGraphPatch(proposed, {
            proposal_id: 'patch-1',
            base_revision_id: state.active_revision_id,
            base_revision_hash: state.active_revision_hash,
            proposed_revision_hash: descriptor.descriptor_hash,
            invalidated_node_ids: ['branch-a'],
            approval_evidence: { kind: 'human', ref: 'approve-invalidating-branch-a' },
            approved_at: '2026-07-21T00:00:02.000Z',
        }, (projection, _descriptor, invalidated) => ({
            ...projection,
            activations: Object.fromEntries(Object.entries(projection.activations).filter(([, activation]) => !invalidated.has(activation.node_id))),
        }));
        expect(approved.active_revision_id).toBe('revision-2');
        expect(approved.active_revision_hash).toBe(descriptor.descriptor_hash);
        expect(approved.pending_patch).toBeUndefined();
        expect(approved.revisions['revision-1'].descriptor.descriptor_hash).toBe(state.active_revision_hash);
        expect(approved.revisions['revision-2'].approval?.evidence.ref).toBe('approve-invalidating-branch-a');
        expect(canonicalJson(approved.revisions['revision-2'].descriptor)).toBe(canonicalJson(descriptor));
        expect(approved.projection.activations.completed).toBeUndefined();
    });
});
//# sourceMappingURL=revision.test.js.map