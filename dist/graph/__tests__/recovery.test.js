import { describe, expect, it } from 'vitest';
import { issueGraphClaim, recordLateClaimResult, recoverExpiredGraphClaim, renewGraphClaim, settleDriverClaims, } from '../claims.js';
import { sealGraphDescriptor } from '../descriptor.js';
import { createInitialGraphState } from '../runtime-types.js';
import { forkJoinDescriptor } from './fixtures.js';
function runningState(policy = 'side_effect_free') {
    const input = forkJoinDescriptor();
    const first = input.nodes.find((node) => node.id === 'analyze');
    if (!first)
        throw new Error('test fixture missing analyze node');
    if (first.kind === 'agent' || first.kind === 'command') {
        first.effect_policy = policy === 'idempotent'
            ? { policy: 'idempotent', idempotency_key_template: 'payment:{attempt}' }
            : { policy };
    }
    const descriptor = sealGraphDescriptor(input);
    return createInitialGraphState({
        session_id: 'session-recovery',
        control_nonce: 'control-recovery',
        descriptor,
        status: 'running',
        created_at: '2026-07-21T00:00:00.000Z',
        projection: {
            activations: {
                activation: {
                    activation_id: 'activation',
                    node_id: 'analyze',
                    status: 'running',
                    attempt_no: 1,
                    attempt_ids: ['attempt-1'],
                    active_attempt_id: 'attempt-1',
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
            evidence: { kind: 'human', ref: 'approval' },
        },
    });
}
function claimState(policy = 'side_effect_free') {
    return issueGraphClaim(runningState(policy), {
        activation_id: 'activation',
        attempt_id: 'attempt-1',
        attempt_no: 1,
        claim_owner_session_id: 'session-recovery',
        driver_instance_id: 'driver-1',
        lease_id: 'lease-1',
        tracking_id: 'tool-1',
        issued_at: '2026-07-21T00:00:00.000Z',
        execution_timeout_ms: 1_000,
        grace_ms: 500,
        max_renewals: 2,
        effect_policy: policy === 'idempotent'
            ? { policy: 'idempotent', idempotency_key_template: 'payment:{attempt}' }
            : { policy },
        ...(policy === 'idempotent' ? { external_idempotency_key: 'payment:42' } : {}),
    }).state;
}
const retryProjection = (projection, input) => ({
    ...projection,
    activations: {
        ...projection.activations,
        [input.activation_id]: {
            ...projection.activations[input.activation_id],
            status: 'running',
            attempt_no: input.attempt_no,
            attempt_ids: [...projection.activations[input.activation_id].attempt_ids, input.attempt_id],
            active_attempt_id: input.attempt_id,
        },
    },
});
describe('graph claim recovery', () => {
    it('renews only the matching live tracked lease before expiry and within its cap', () => {
        const state = claimState();
        const renewed = renewGraphClaim(state, {
            lease_id: 'lease-1',
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            tracking_id: 'tool-1',
            tool_still_running: true,
            now: '2026-07-21T00:00:01.000Z',
        });
        expect(renewed.state.claims['lease-1']).toMatchObject({
            renewal_count: 1,
            expires_at: '2026-07-21T00:00:02.500Z',
        });
        expect(() => renewGraphClaim(renewed.state, {
            lease_id: 'lease-1',
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            tracking_id: 'different-tool',
            tool_still_running: true,
            now: '2026-07-21T00:00:01.100Z',
        })).toThrow(/tracking/i);
        const second = renewGraphClaim(renewed.state, {
            lease_id: 'lease-1',
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            tracking_id: 'tool-1',
            tool_still_running: true,
            now: '2026-07-21T00:00:02.000Z',
        });
        expect(() => renewGraphClaim(second.state, {
            lease_id: 'lease-1',
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            tracking_id: 'tool-1',
            tool_still_running: true,
            now: '2026-07-21T00:00:02.100Z',
        })).toThrow(/renewal cap/i);
        expect(() => renewGraphClaim(state, {
            lease_id: 'lease-1',
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            tracking_id: 'tool-1',
            tool_still_running: true,
            now: '2026-07-21T00:00:02.000Z',
        })).toThrow(/expired/i);
    });
    it('binds issuance to the authority session and exact approved node timeout', () => {
        const state = runningState();
        const base = {
            activation_id: 'activation',
            attempt_id: 'attempt-1',
            attempt_no: 1,
            claim_owner_session_id: 'different-session',
            driver_instance_id: 'driver-1',
            lease_id: 'lease-invalid',
            tracking_id: 'tool-1',
            issued_at: '2026-07-21T00:00:00.000Z',
            execution_timeout_ms: 1_000,
            grace_ms: 500,
            max_renewals: 2,
            effect_policy: { policy: 'side_effect_free' },
        };
        expect(() => issueGraphClaim(state, base)).toThrow(/authority session/i);
        expect(() => issueGraphClaim(state, {
            ...base,
            claim_owner_session_id: 'session-recovery',
            execution_timeout_ms: 2_000,
        })).toThrow(/approved node timeout/i);
        expect(() => recoverExpiredGraphClaim(claimState(), {
            lease_id: 'lease-1',
            now: '2026-07-21T00:00:02.000Z',
            new_attempt_id: 'attempt-2',
            new_lease_id: 'lease-2',
            new_tracking_id: 'tool-2',
            claimant_session_id: 'different-session',
            driver_instance_id: 'driver-2',
            reconciliation_id: 'reconciliation-1',
        }, retryProjection)).toThrow(/authority session/i);
    });
    it('takes over idempotent work only with its durable key intact', () => {
        const recovered = recoverExpiredGraphClaim(claimState('idempotent'), {
            lease_id: 'lease-1',
            now: '2026-07-21T00:00:02.000Z',
            new_attempt_id: 'attempt-2',
            new_lease_id: 'lease-2',
            new_tracking_id: 'tool-2',
            claimant_session_id: 'session-recovery',
            driver_instance_id: 'driver-2',
            reconciliation_id: 'reconciliation-1',
        }, retryProjection);
        expect(recovered.disposition).toBe('taken_over');
        expect(recovered.state.claims['lease-2'].external_idempotency_key).toBe('payment:42');
    });
    it('takes over expired retry-safe work with a new attempt while retaining activation identity', () => {
        const state = claimState();
        const recovered = recoverExpiredGraphClaim(state, {
            lease_id: 'lease-1',
            now: '2026-07-21T00:00:02.000Z',
            new_attempt_id: 'attempt-2',
            new_lease_id: 'lease-2',
            new_tracking_id: 'tool-2',
            claimant_session_id: 'session-recovery',
            driver_instance_id: 'driver-2',
            reconciliation_id: 'reconciliation-1',
        }, retryProjection);
        expect(recovered.disposition).toBe('taken_over');
        expect(recovered.state.claims['lease-1'].status).toBe('expired_retryable');
        expect(recovered.state.claims['lease-2']).toMatchObject({
            status: 'live',
            activation_id: 'activation',
            attempt_id: 'attempt-2',
            attempt_no: 2,
        });
        expect(recovered.state.projection.activations.activation.attempt_ids).toEqual([
            'attempt-1',
            'attempt-2',
        ]);
        expect(() => recoverExpiredGraphClaim(recovered.state, {
            lease_id: 'lease-2',
            now: '2026-07-21T00:00:04.000Z',
            new_attempt_id: 'attempt-3',
            new_lease_id: 'lease-3',
            new_tracking_id: 'tool-3',
            claimant_session_id: 'session-recovery',
            driver_instance_id: 'driver-3',
            reconciliation_id: 'reconciliation-2',
        }, retryProjection)).toThrow(/maximum attempts/i);
    });
    it('moves ambiguous expired work to reconciliation and never creates a replacement claim', () => {
        const state = claimState('reconcile');
        const recovered = recoverExpiredGraphClaim(state, {
            lease_id: 'lease-1',
            now: '2026-07-21T00:00:02.000Z',
            new_attempt_id: 'attempt-2',
            new_lease_id: 'lease-2',
            new_tracking_id: 'tool-2',
            claimant_session_id: 'session-recovery',
            driver_instance_id: 'driver-2',
            reconciliation_id: 'reconciliation-1',
        }, () => {
            throw new Error('ambiguous work must not retry');
        });
        expect(recovered.disposition).toBe('reconciling');
        expect(recovered.state.claims['lease-2']).toBeUndefined();
        expect(recovered.state.reconciliations['reconciliation-1']).toMatchObject({
            status: 'unresolved',
            activation_id: 'activation',
        });
    });
    it('records an expired lease completion only as bounded diagnostic evidence', () => {
        const state = recoverExpiredGraphClaim(claimState(), {
            lease_id: 'lease-1',
            now: '2026-07-21T00:00:02.000Z',
            new_attempt_id: 'attempt-2',
            new_lease_id: 'lease-2',
            new_tracking_id: 'tool-2',
            claimant_session_id: 'session-recovery',
            driver_instance_id: 'driver-2',
            reconciliation_id: 'reconciliation-1',
        }, retryProjection).state;
        const projection = state.projection;
        const late = recordLateClaimResult(state, {
            lease_id: 'lease-1',
            attempt_id: 'attempt-1',
            recorded_at: '2026-07-21T00:00:03.000Z',
            summary: 'old result arrived after takeover',
        });
        expect(late.state.projection).toStrictEqual(projection);
        expect(late.state.diagnostics.at(-1)).toMatchObject({
            kind: 'late_result',
            lease_id: 'lease-1',
            attempt_id: 'attempt-1',
        });
    });
    it('fences SessionEnd claims without deleting their authority', () => {
        const safe = settleDriverClaims(claimState(), {
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            recorded_at: '2026-07-21T00:00:01.000Z',
        });
        const ambiguous = settleDriverClaims(claimState('reconcile'), {
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            recorded_at: '2026-07-21T00:00:01.000Z',
        });
        expect(safe.state.claims['lease-1'].status).toBe('abandoned_retryable');
        expect(ambiguous.state.claims['lease-1'].status).toBe('reconciling');
        expect(Object.values(ambiguous.state.reconciliations)).toHaveLength(1);
    });
    it('B4: session-end scope fences ALL live claims regardless of driver-id', () => {
        // Two live claims owned by different drivers in the same session.
        const base = claimState();
        const secondClaim = issueGraphClaim(runningState(), {
            activation_id: 'activation',
            attempt_id: 'attempt-1',
            attempt_no: 1,
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-2',
            lease_id: 'lease-2',
            tracking_id: 'tool-2',
            issued_at: '2026-07-21T00:00:00.000Z',
            execution_timeout_ms: 1_000,
            grace_ms: 500,
            max_renewals: 2,
            effect_policy: { policy: 'side_effect_free' },
        });
        // claimState() already has lease-1 (driver-1); add lease-2 (driver-2).
        const both = {
            ...secondClaim.state,
            claims: {
                ...base.claims,
                ...secondClaim.state.claims,
            },
        };
        // driver scope (default) only fences driver-1's claim.
        const driverScoped = settleDriverClaims(both, {
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            recorded_at: '2026-07-21T00:00:01.000Z',
        });
        expect(driverScoped.settled_lease_ids).toEqual(['lease-1']);
        expect(driverScoped.state.claims['lease-2'].status).toBe('live');
        // session scope fences both claims even though only driver-1 was passed.
        const sessionScoped = settleDriverClaims(both, {
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            recorded_at: '2026-07-21T00:00:01.000Z',
            scope: 'session',
        });
        expect(sessionScoped.settled_lease_ids.sort()).toEqual(['lease-1', 'lease-2']);
        expect(sessionScoped.state.claims['lease-1'].status).toBe('abandoned_retryable');
        expect(sessionScoped.state.claims['lease-2'].status).toBe('abandoned_retryable');
    });
    it('WEDGE 2: SessionEnd settles a non-ambiguous human-approval claim and returns the run to re-claimable running', () => {
        // A human-approval node holds the run in 'waiting_human' while a live claim
        // fences its activation waiting for the human answer. When SessionEnd
        // settles that claim (non-ambiguous: human-approval claims carry
        // side_effect_free), the claim must be abandoned_retryable, the activation
        // reset to 'ready', AND the run must leave 'waiting_human' for 'running' so
        // issueGraphClaim can re-claim the activation instead of wedging.
        const base = runningState();
        // Bind a live human-approval claim and move the run to waiting_human, mirroring
        // the runtime dispatch path (runtime.ts human-approval branch).
        const waitingHuman = {
            ...base,
            status: 'waiting_human',
            claims: {
                'lease-human': {
                    run_id: base.run_id,
                    revision_id: base.active_revision_id,
                    revision_hash: base.active_revision_hash,
                    dispatch_generation: base.dispatch_generation,
                    activation_id: 'activation',
                    attempt_id: 'attempt-1',
                    attempt_no: 1,
                    claim_owner_session_id: base.session_id,
                    driver_instance_id: 'driver-1',
                    lease_id: 'lease-human',
                    tracking_id: 'tool-1',
                    issued_at: '2026-07-21T00:00:00.000Z',
                    expires_at: '2026-07-21T01:00:00.000Z',
                    lease_duration_ms: 3_600_000,
                    renewal_count: 0,
                    max_renewals: 0,
                    effect_policy: { policy: 'side_effect_free' },
                    status: 'live',
                },
            },
        };
        const settled = settleDriverClaims(waitingHuman, {
            claim_owner_session_id: 'session-recovery',
            driver_instance_id: 'driver-1',
            recorded_at: '2026-07-21T00:00:01.000Z',
            scope: 'session',
        });
        expect(settled.settled_lease_ids).toEqual(['lease-human']);
        expect(settled.state.claims['lease-human'].status).toBe('abandoned_retryable');
        // The activation is reset to ready (active attempt dropped).
        expect(settled.state.projection.activations['activation'].status).toBe('ready');
        expect(settled.state.projection.activations['activation'].active_attempt_id).toBeUndefined();
        // WEDGE 2 fix: the run is no longer wedged in waiting_human; it is running
        // again so the scheduler dispatch path (which beginActivationAttempt ->
        // issueGraphClaim on a ready activation) can re-claim it. A run stuck in
        // waiting_human would block dispatch entirely (issueGraphClaim requires
        // status === 'running').
        expect(settled.state.status).toBe('running');
        expect(settled.state.projection.activations['activation'].status).toBe('ready');
    });
});
//# sourceMappingURL=recovery.test.js.map