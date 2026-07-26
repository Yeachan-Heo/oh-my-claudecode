const SIDE_EFFECT_FREE = { policy: 'side_effect_free' };
export function executableNode(id, kind = 'agent') {
    if (kind === 'command') {
        return {
            id,
            kind,
            title: id,
            command: `run-${id}`,
            timeout_ms: 1_000,
            max_attempts: 2,
            effect_policy: SIDE_EFFECT_FREE,
        };
    }
    return {
        id,
        kind,
        title: id,
        instructions: `Do ${id}`,
        timeout_ms: 1_000,
        max_attempts: 2,
        effect_policy: SIDE_EFFECT_FREE,
    };
}
export function forkJoinDescriptor() {
    return {
        descriptor_version: 1,
        run_id: 'run-1',
        revision_id: 'revision-1',
        goal: 'Build and verify two branches',
        entry_node_ids: ['approval'],
        concurrency_limit: 2,
        terminal_verification_node_id: 'verify',
        nodes: [
            {
                id: 'approval',
                kind: 'human-approval',
                title: 'Approve the graph',
                prompt: 'Approve this graph revision?',
            },
            executableNode('analyze'),
            executableNode('branch-a'),
            executableNode('branch-b', 'command'),
            {
                id: 'join-build',
                kind: 'join',
                title: 'Join build branches',
                fan_out_node_id: 'analyze',
                input_branch_ids: ['a', 'b'],
            },
            executableNode('verify', 'command'),
        ],
        edges: [
            { id: 'approval-to-analyze', kind: 'fixed', from: 'approval', to: 'analyze' },
            {
                id: 'fan-a',
                kind: 'fan_out',
                from: 'analyze',
                to: 'branch-a',
                branch_id: 'a',
                owner_join_id: 'join-build',
            },
            {
                id: 'fan-b',
                kind: 'fan_out',
                from: 'analyze',
                to: 'branch-b',
                branch_id: 'b',
                owner_join_id: 'join-build',
            },
            { id: 'a-to-join', kind: 'fixed', from: 'branch-a', to: 'join-build' },
            { id: 'b-to-join', kind: 'fixed', from: 'branch-b', to: 'join-build' },
            { id: 'join-to-verify', kind: 'fixed', from: 'join-build', to: 'verify' },
        ],
    };
}
export function loopDescriptor() {
    return {
        descriptor_version: 1,
        run_id: 'run-loop',
        revision_id: 'revision-loop',
        goal: 'Retry a failing verification within a bound',
        entry_node_ids: ['start'],
        concurrency_limit: 1,
        terminal_verification_node_id: 'verify',
        nodes: [
            executableNode('start'),
            executableNode('test', 'command'),
            executableNode('remediate'),
            executableNode('verify', 'command'),
        ],
        edges: [
            { id: 'start-test', kind: 'fixed', from: 'start', to: 'test' },
            { id: 'test-pass', kind: 'conditional', from: 'test', to: 'verify', route: 'pass' },
            { id: 'test-fail', kind: 'conditional', from: 'test', to: 'remediate', route: 'fail' },
            // Forward exit from remediate so the node is not back-edge-only: once the
            // retry bound is exhausted the run can still proceed to verification
            // instead of wedging with traversal_bound_exceeded.
            { id: 'remediate-give-up', kind: 'conditional', from: 'remediate', to: 'verify', route: 'give-up' },
            {
                id: 'retry-test',
                kind: 'back_edge',
                from: 'remediate',
                to: 'test',
                route: 'retry',
                max_traversals: 2,
            },
        ],
    };
}
//# sourceMappingURL=fixtures.js.map