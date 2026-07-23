import { createHash } from 'node:crypto';

import { parseGraphDescriptorShape } from './schema.js';
import type {
  GraphBackEdge,
  GraphDescriptor,
  GraphDescriptorInput,
  GraphEdge,
  GraphFanOutEdge,
  GraphNode,
  SealedGraphDescriptor,
} from './types.js';

export class GraphDescriptorValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid graph descriptor: ${issues.join('; ')}`);
    this.name = 'GraphDescriptorValidationError';
    this.issues = issues;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

function descriptorHashPayload(input: GraphDescriptorInput): Omit<GraphDescriptorInput, 'descriptor_hash'> {
  return {
    descriptor_version: input.descriptor_version,
    run_id: input.run_id,
    revision_id: input.revision_id,
    goal: input.goal,
    nodes: input.nodes,
    edges: input.edges,
    entry_node_ids: input.entry_node_ids,
    concurrency_limit: input.concurrency_limit,
    terminal_verification_node_id: input.terminal_verification_node_id,
  };
}

export function computeDescriptorHash(input: GraphDescriptorInput): string {
  return createHash('sha256').update(canonicalJson(descriptorHashPayload(input))).digest('hex');
}

export function verifyDescriptorHash(
  input: GraphDescriptorInput,
): input is SealedGraphDescriptor {
  return typeof input.descriptor_hash === 'string'
    && input.descriptor_hash === computeDescriptorHash(input);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) found.add(value);
    seen.add(value);
  }
  return [...found].sort();
}

function groupByFrom(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const result = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const group = result.get(edge.from) ?? [];
    group.push(edge);
    result.set(edge.from, group);
  }
  return result;
}

function adjacencyFor(edges: GraphEdge[], includeBackEdges: boolean): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    if (!includeBackEdges && edge.kind === 'back_edge') continue;
    const targets = result.get(edge.from) ?? [];
    targets.push(edge.to);
    result.set(edge.from, targets);
  }
  return result;
}

function isReachable(start: string, target: string, adjacency: Map<string, string[]>): boolean {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function reachableSet(starts: string[], adjacency: Map<string, string[]>): Set<string> {
  const pending = [...starts];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return visited;
}

function findForwardCycle(nodeIds: string[], adjacency: Map<string, string[]>): string[] | undefined {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (nodeId: string): string[] | undefined => {
    if (active.has(nodeId)) {
      const start = stack.indexOf(nodeId);
      return [...stack.slice(start), nodeId];
    }
    if (visited.has(nodeId)) return undefined;
    visited.add(nodeId);
    active.add(nodeId);
    stack.push(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(nodeId);
    return undefined;
  };

  for (const nodeId of nodeIds) {
    const cycle = visit(nodeId);
    if (cycle) return cycle;
  }
  return undefined;
}

interface ForkBranchRegion {
  fanOutNodeId: string;
  joinNodeId: string;
  branchId: string;
  startNodeId: string;
  nodes: Set<string>;
}

function collectBranchRegion(
  edge: GraphFanOutEdge,
  allAdjacency: Map<string, string[]>,
  joinNodeId: string,
): Set<string> {
  const pending = [edge.to];
  const result = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === joinNodeId || result.has(current)) continue;
    result.add(current);
    pending.push(...(allAdjacency.get(current) ?? []));
  }
  return result;
}

function validateOutgoingContracts(
  descriptor: GraphDescriptor,
  nodes: Map<string, GraphNode>,
  outgoing: Map<string, GraphEdge[]>,
  issues: string[],
): void {
  for (const node of descriptor.nodes) {
    const edges = outgoing.get(node.id) ?? [];
    if (node.id === descriptor.terminal_verification_node_id) {
      if (edges.length > 0) issues.push(`terminal verification node ${node.id} must not have outgoing edges`);
      continue;
    }
    if (edges.length === 0) {
      issues.push(`node ${node.id} cannot reach terminal verification because it has no outgoing edge`);
      continue;
    }

    // A node whose only outgoing edge(s) are back_edges has no forward exit.
    // Once max_traversals is exhausted the scheduler's selectEdges throws
    // traversal_bound_exceeded on the completing path, leaving the result
    // permanently uncommittable and the claim wedged. Require every non-terminal
    // node to declare at least one non-back-edge exit path.
    if (edges.every((edge) => edge.kind === 'back_edge')) {
      issues.push(
        `node ${node.id} has no non-back-edge exit; a back-edge-only node wedges once max_traversals is exhausted`,
      );
    }

    const kinds = new Set(edges.map((edge) => edge.kind));
    if (node.kind === 'join') {
      if (edges.length !== 1 || edges[0].kind !== 'fixed') {
        issues.push(`join node ${node.id} must have exactly one fixed outgoing edge`);
      }
      continue;
    }
    if (kinds.has('fixed') && (edges.length !== 1 || kinds.size !== 1)) {
      issues.push(`node ${node.id} must use one fixed edge or an explicit route/fan-out set`);
    }
    if (kinds.has('fan_out')) {
      if (kinds.size !== 1 || edges.length < 2) {
        issues.push(`fan-out node ${node.id} must declare at least two fan_out edges and no other edge kind`);
      }
    } else if (!kinds.has('fixed')) {
      if ([...kinds].some((kind) => kind !== 'conditional' && kind !== 'back_edge')) {
        issues.push(`node ${node.id} has an unsupported routed edge combination`);
      }
      const routes = edges
        .filter((edge): edge is Extract<GraphEdge, { route: string }> => 'route' in edge)
        .map((edge) => edge.route);
      const repeatedRoutes = duplicates(routes);
      if (repeatedRoutes.length > 0) {
        issues.push(`node ${node.id} declares duplicate route(s): ${repeatedRoutes.join(', ')}`);
      }
    }
  }

  for (const edge of descriptor.edges) {
    if (!nodes.has(edge.from)) issues.push(`edge ${edge.id} references missing source node ${edge.from}`);
    if (!nodes.has(edge.to)) issues.push(`edge ${edge.id} references missing target node ${edge.to}`);
  }
}

function validateForkRegions(
  descriptor: GraphDescriptor,
  nodes: Map<string, GraphNode>,
  outgoing: Map<string, GraphEdge[]>,
  allAdjacency: Map<string, string[]>,
  issues: string[],
): void {
  const fanGroups = new Map<string, GraphFanOutEdge[]>();
  for (const edge of descriptor.edges) {
    if (edge.kind !== 'fan_out') continue;
    const group = fanGroups.get(edge.from) ?? [];
    group.push(edge);
    fanGroups.set(edge.from, group);
  }

  const regions: ForkBranchRegion[] = [];
  for (const [fanOutNodeId, fanEdges] of fanGroups) {
    const ownerJoinIds = new Set(fanEdges.map((edge) => edge.owner_join_id));
    if (ownerJoinIds.size !== 1) {
      issues.push(`fan-out node ${fanOutNodeId} must have one owning join`);
      continue;
    }
    const joinNodeId = fanEdges[0].owner_join_id;
    const joinNode = nodes.get(joinNodeId);
    if (joinNode?.kind !== 'join') {
      issues.push(`fan-out node ${fanOutNodeId} references non-join owner ${joinNodeId}`);
      continue;
    }
    if (joinNode.fan_out_node_id !== fanOutNodeId) {
      issues.push(`join ${joinNodeId} does not bind fan-out node ${fanOutNodeId}`);
    }
    const branchIds = fanEdges.map((edge) => edge.branch_id);
    const repeatedBranches = duplicates(branchIds);
    if (repeatedBranches.length > 0) {
      issues.push(`fan-out node ${fanOutNodeId} repeats branch ID(s): ${repeatedBranches.join(', ')}`);
    }
    if (
      [...new Set(branchIds)].sort().join('\0')
      !== [...new Set(joinNode.input_branch_ids)].sort().join('\0')
    ) {
      issues.push(`join ${joinNodeId} input branches do not match fan-out ${fanOutNodeId}`);
    }
    if (duplicates(joinNode.input_branch_ids).length > 0) {
      issues.push(`join ${joinNodeId} repeats an input branch ID`);
    }

    const groupRegions: ForkBranchRegion[] = fanEdges.map((edge) => ({
      fanOutNodeId,
      joinNodeId,
      branchId: edge.branch_id,
      startNodeId: edge.to,
      nodes: collectBranchRegion(edge, allAdjacency, joinNodeId),
    }));
    regions.push(...groupRegions);

    for (const region of groupRegions) {
      if (!region.nodes.has(region.startNodeId)) {
        issues.push(`fork branch ${region.branchId} has no region`);
      }
      if (!isReachable(region.startNodeId, joinNodeId, allAdjacency)) {
        issues.push(`fork branch ${region.branchId} cannot reach owning join ${joinNodeId}`);
      }
      for (const nodeId of region.nodes) {
        const node = nodes.get(nodeId);
        if (node?.kind === 'join' && nodeId !== joinNodeId) {
          issues.push(`nested join ${nodeId} is not allowed inside fork region ${fanOutNodeId}`);
        }
        if ((outgoing.get(nodeId) ?? []).some((edge) => edge.kind === 'fan_out')) {
          issues.push(`nested fan-out ${nodeId} is not allowed inside fork region ${fanOutNodeId}`);
        }
        if (!isReachable(nodeId, joinNodeId, allAdjacency)) {
          issues.push(`fork branch ${region.branchId} contains node ${nodeId} that cannot reach its join`);
        }
      }
      const reachesJoin = descriptor.edges.some(
        (edge) => region.nodes.has(edge.from) && edge.to === joinNodeId,
      );
      if (!reachesJoin) issues.push(`fork branch ${region.branchId} has no declared join input`);
    }

    for (let left = 0; left < groupRegions.length; left += 1) {
      for (let right = left + 1; right < groupRegions.length; right += 1) {
        const overlap = [...groupRegions[left].nodes].filter((id) => groupRegions[right].nodes.has(id));
        if (overlap.length > 0) {
          issues.push(
            `fork branches ${groupRegions[left].branchId} and ${groupRegions[right].branchId} overlap at ${overlap.join(', ')}`,
          );
        }
      }
    }
  }

  for (const node of descriptor.nodes) {
    if (node.kind === 'join' && !fanGroups.has(node.fan_out_node_id)) {
      issues.push(`join ${node.id} has no matching fan-out node ${node.fan_out_node_id}`);
    }
  }

  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      if (regions[left].fanOutNodeId === regions[right].fanOutNodeId) continue;
      const overlap = [...regions[left].nodes].some((id) => regions[right].nodes.has(id));
      if (overlap) {
        issues.push(
          `fork regions ${regions[left].fanOutNodeId} and ${regions[right].fanOutNodeId} overlap or nest`,
        );
      }
    }
  }

  for (const region of regions) {
    for (const edge of descriptor.edges) {
      if (edge.kind === 'fan_out' && edge.from === region.fanOutNodeId && edge.branch_id === region.branchId) {
        continue;
      }
      const fromInside = region.nodes.has(edge.from);
      const toInside = region.nodes.has(edge.to);
      if (!fromInside && toInside) {
        issues.push(`edge ${edge.id} crosses into fork branch ${region.branchId}`);
      }
      if (fromInside && !toInside && edge.to !== region.joinNodeId) {
        issues.push(`edge ${edge.id} crosses out of fork branch ${region.branchId}`);
      }
      if (edge.kind === 'back_edge' && fromInside !== toInside) {
        issues.push(`back-edge ${edge.id} crosses fork region ${region.fanOutNodeId}`);
      }
    }
  }

  for (const node of descriptor.nodes) {
    if (node.kind !== 'join') continue;
    const ownerRegions = regions.filter((region) => region.joinNodeId === node.id);
    for (const edge of descriptor.edges.filter((candidate) => candidate.to === node.id)) {
      if (!ownerRegions.some((region) => region.nodes.has(edge.from))) {
        issues.push(`edge ${edge.id} enters join ${node.id} outside its owning fork region`);
      }
    }
  }
}

export function validateGraphDescriptor(descriptor: GraphDescriptor): GraphDescriptor {
  const issues: string[] = [];
  const repeatedNodeIds = duplicates(descriptor.nodes.map((node) => node.id));
  if (repeatedNodeIds.length > 0) issues.push(`duplicate node ID(s): ${repeatedNodeIds.join(', ')}`);
  const repeatedEdgeIds = duplicates(descriptor.edges.map((edge) => edge.id));
  if (repeatedEdgeIds.length > 0) issues.push(`duplicate edge ID(s): ${repeatedEdgeIds.join(', ')}`);
  const repeatedEntries = duplicates(descriptor.entry_node_ids);
  if (repeatedEntries.length > 0) issues.push(`duplicate entry node ID(s): ${repeatedEntries.join(', ')}`);

  const nodes = new Map(descriptor.nodes.map((node) => [node.id, node]));
  const outgoing = groupByFrom(descriptor.edges);
  validateOutgoingContracts(descriptor, nodes, outgoing, issues);

  for (const entry of descriptor.entry_node_ids) {
    if (!nodes.has(entry)) issues.push(`entry node ${entry} does not exist`);
  }
  const terminalNode = nodes.get(descriptor.terminal_verification_node_id);
  if (!terminalNode) {
    issues.push(`terminal verification node ${descriptor.terminal_verification_node_id} does not exist`);
  } else if (terminalNode.kind !== 'agent' && terminalNode.kind !== 'command') {
    issues.push('terminal verification must be an executable agent or command node');
  }

  const allAdjacency = adjacencyFor(descriptor.edges, true);
  const forwardAdjacency = adjacencyFor(descriptor.edges, false);
  const reachable = reachableSet(descriptor.entry_node_ids, allAdjacency);
  const unreachable = descriptor.nodes.map((node) => node.id).filter((id) => !reachable.has(id));
  if (unreachable.length > 0) issues.push(`unreachable node(s): ${unreachable.join(', ')}`);

  const cycle = findForwardCycle(descriptor.nodes.map((node) => node.id), forwardAdjacency);
  if (cycle) issues.push(`non-back-edge cycle detected: ${cycle.join(' -> ')}`);

  for (const edge of descriptor.edges.filter(
    (candidate): candidate is GraphBackEdge => candidate.kind === 'back_edge',
  )) {
    if (!isReachable(edge.to, edge.from, forwardAdjacency)) {
      issues.push(`back-edge ${edge.id} is not a structural return to an earlier node`);
    }
  }

  if (terminalNode) {
    const cannotVerify = descriptor.nodes
      .map((node) => node.id)
      .filter((id) => !isReachable(id, terminalNode.id, allAdjacency));
    if (cannotVerify.length > 0) {
      issues.push(
        `every successful path must reach terminal verification; failing node(s): ${cannotVerify.join(', ')}`,
      );
    }
  }

  validateForkRegions(descriptor, nodes, outgoing, allAdjacency, issues);
  if (issues.length > 0) throw new GraphDescriptorValidationError([...new Set(issues)]);
  return descriptor;
}

export function parseGraphDescriptor(input: unknown): GraphDescriptor {
  const descriptor = validateGraphDescriptor(parseGraphDescriptorShape(input));
  if (descriptor.descriptor_hash && !verifyDescriptorHash(descriptor)) {
    throw new GraphDescriptorValidationError(['descriptor hash does not match the exact revision']);
  }
  return descriptor;
}

export function sealGraphDescriptor(input: unknown): SealedGraphDescriptor {
  const descriptor = parseGraphDescriptor(input);
  return {
    ...descriptor,
    descriptor_hash: computeDescriptorHash(descriptor),
  };
}
