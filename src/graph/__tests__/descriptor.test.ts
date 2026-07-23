import { describe, expect, it } from 'vitest';

import {
  GraphDescriptorValidationError,
  canonicalJson,
  computeDescriptorHash,
  parseGraphDescriptor,
  sealGraphDescriptor,
  verifyDescriptorHash,
} from '../index.js';
import { executableNode, forkJoinDescriptor, loopDescriptor } from './fixtures.js';

describe('graph descriptor', () => {
  it('strictly parses all four node kinds and seals the exact revision', () => {
    const input = forkJoinDescriptor();
    const sealed = sealGraphDescriptor(input);

    expect(sealed.descriptor_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyDescriptorHash(sealed)).toBe(true);
    expect(parseGraphDescriptor(sealed)).toEqual(sealed);
    expect(new Set(sealed.nodes.map((node) => node.kind))).toEqual(
      new Set(['agent', 'command', 'human-approval', 'join']),
    );
  });

  it('rejects unknown fields, duplicate IDs, and undeclared conditional routes', () => {
    const extra = { ...forkJoinDescriptor(), status: 'running' };
    expect(() => parseGraphDescriptor(extra)).toThrow();

    const duplicate = forkJoinDescriptor();
    duplicate.nodes.push(executableNode('branch-a'));
    expect(() => parseGraphDescriptor(duplicate)).toThrow(GraphDescriptorValidationError);

    const routes = loopDescriptor();
    routes.edges.push({
      id: 'test-pass-2',
      kind: 'conditional',
      from: 'test',
      to: 'verify',
      route: 'pass',
    });
    expect(() => parseGraphDescriptor(routes)).toThrow(/route/i);
  });

  it('uses compact key-sorted canonical JSON and excludes hash/runtime fields', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}');

    const descriptor = forkJoinDescriptor();
    const first = computeDescriptorHash(descriptor);
    const decorated = {
      ...descriptor,
      descriptor_hash: 'f'.repeat(64),
      status: 'running',
      updated_at: 'later',
    };

    expect(computeDescriptorHash(decorated)).toBe(first);
    expect(computeDescriptorHash({ ...descriptor, goal: 'Different goal' })).not.toBe(first);
  });

  it('accepts a bounded return and rejects a non-back-edge cycle', () => {
    expect(() => parseGraphDescriptor(loopDescriptor())).not.toThrow();

    const cycle = loopDescriptor();
    // Convert the retry back_edge (now at index 4 after the forward give-up
    // exit was added to remediate) into a conditional so the remediate->test
    // return becomes a forward cycle.
    const retryEdge = cycle.edges.find((edge) => edge.id === 'retry-test')!;
    cycle.edges[cycle.edges.indexOf(retryEdge)] = {
      id: 'retry-test',
      kind: 'conditional',
      from: 'remediate',
      to: 'test',
      route: 'retry',
    };
    expect(() => parseGraphDescriptor(cycle)).toThrow(/cycle/i);
  });

  it('requires every reachable successful path to lead to terminal verification', () => {
    const descriptor = loopDescriptor();
    descriptor.nodes.push(executableNode('dead-end'));
    descriptor.edges.push({
      id: 'test-abandon',
      kind: 'conditional',
      from: 'test',
      to: 'dead-end',
      route: 'abandon',
    });

    expect(() => parseGraphDescriptor(descriptor)).toThrow(/terminal verification/i);
  });

  it('rejects a non-terminal node whose only outgoing edge is a back_edge (wedged once max_traversals is exhausted)', () => {
    // A back-edge-only node has no forward exit: once max_traversals is
    // exhausted, selectEdges throws traversal_bound_exceeded on the completing
    // path and the result becomes permanently uncommittable. Require a
    // non-back-edge exit path for every non-terminal node.
    const descriptor = loopDescriptor();
    // Remove the forward give-up exit so remediate is back-edge-only.
    descriptor.edges = descriptor.edges.filter((edge) => edge.id !== 'remediate-give-up');

    expect(() => parseGraphDescriptor(descriptor)).toThrow(/non-back-edge exit/i);
  });

  it('accepts branch-local returns and rejects fork region crossings', () => {
    const local = forkJoinDescriptor();
    local.nodes.push(executableNode('branch-a-check'), executableNode('branch-a-fix'));
    local.edges = local.edges.filter((edge) => edge.id !== 'a-to-join');
    local.edges.push(
      { id: 'a-to-check', kind: 'fixed', from: 'branch-a', to: 'branch-a-check' },
      {
        id: 'a-check-pass',
        kind: 'conditional',
        from: 'branch-a-check',
        to: 'join-build',
        route: 'pass',
      },
      {
        id: 'a-check-fail',
        kind: 'conditional',
        from: 'branch-a-check',
        to: 'branch-a-fix',
        route: 'fail',
      },
      {
        id: 'a-fix-give-up',
        kind: 'conditional',
        from: 'branch-a-fix',
        to: 'join-build',
        route: 'give-up',
      },
      {
        id: 'a-return',
        kind: 'back_edge',
        from: 'branch-a-fix',
        to: 'branch-a-check',
        route: 'retry',
        max_traversals: 2,
      },
    );
    expect(() => parseGraphDescriptor(local)).not.toThrow();

    const crossing = structuredClone(local);
    const returnEdge = crossing.edges.find((edge) => edge.id === 'a-return');
    if (returnEdge?.kind === 'back_edge') returnEdge.to = 'branch-b';
    expect(() => parseGraphDescriptor(crossing)).toThrow(/fork|branch|region/i);
  });

  it('rejects nested forks and accepts sequential fork/join regions', () => {
    const nested = forkJoinDescriptor();
    nested.nodes.push(
      executableNode('nested-a'),
      executableNode('nested-b'),
      {
        id: 'nested-join',
        kind: 'join',
        title: 'Nested join',
        fan_out_node_id: 'branch-a',
        input_branch_ids: ['nested-a', 'nested-b'],
      },
    );
    nested.edges = nested.edges.filter((edge) => edge.id !== 'a-to-join');
    nested.edges.push(
      {
        id: 'nested-fan-a',
        kind: 'fan_out',
        from: 'branch-a',
        to: 'nested-a',
        branch_id: 'nested-a',
        owner_join_id: 'nested-join',
      },
      {
        id: 'nested-fan-b',
        kind: 'fan_out',
        from: 'branch-a',
        to: 'nested-b',
        branch_id: 'nested-b',
        owner_join_id: 'nested-join',
      },
      { id: 'nested-a-join', kind: 'fixed', from: 'nested-a', to: 'nested-join' },
      { id: 'nested-b-join', kind: 'fixed', from: 'nested-b', to: 'nested-join' },
      { id: 'nested-out', kind: 'fixed', from: 'nested-join', to: 'join-build' },
    );
    expect(() => parseGraphDescriptor(nested)).toThrow(/nested|fork region/i);

    const sequential = forkJoinDescriptor();
    sequential.nodes.push(
      executableNode('fan-second'),
      executableNode('second-a'),
      executableNode('second-b'),
      {
        id: 'join-second',
        kind: 'join',
        title: 'Second join',
        fan_out_node_id: 'fan-second',
        input_branch_ids: ['a2', 'b2'],
      },
    );
    sequential.edges = sequential.edges.filter((edge) => edge.id !== 'join-to-verify');
    sequential.edges.push(
      { id: 'first-to-second', kind: 'fixed', from: 'join-build', to: 'fan-second' },
      {
        id: 'second-fan-a',
        kind: 'fan_out',
        from: 'fan-second',
        to: 'second-a',
        branch_id: 'a2',
        owner_join_id: 'join-second',
      },
      {
        id: 'second-fan-b',
        kind: 'fan_out',
        from: 'fan-second',
        to: 'second-b',
        branch_id: 'b2',
        owner_join_id: 'join-second',
      },
      { id: 'second-a-join', kind: 'fixed', from: 'second-a', to: 'join-second' },
      { id: 'second-b-join', kind: 'fixed', from: 'second-b', to: 'join-second' },
      { id: 'second-to-verify', kind: 'fixed', from: 'join-second', to: 'verify' },
    );
    expect(() => parseGraphDescriptor(sequential)).not.toThrow();
  });
});
