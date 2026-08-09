/**
 * Graph Core descriptor sealing, structure-before-hash validation, and
 * ownership producers.
 *
 * Contract-authored from spec `deep-interview-issue-3570-graph-core.md` and the
 * ralplan stage-04 revision (`pending-approval.md`); oracle `99ffe31` used only
 * for behavioral cross-checks, never as import authority or copied structure.
 *
 * Ownership flow (disjoint input classes):
 * - `parseGraphDescriptor` — hashless draft parser; rejects hash-bearing input.
 * - `sealGraphDescriptor` — sole draft → scheduler producer (computes the hash).
 * - `parseSealedGraphDescriptor` — sole persisted → scheduler producer
 *   (verifies the supplied hash; rejects mismatch; never silently recomputes).
 * - `verifyDescriptorHash` — non-branding boolean predicate; never throws.
 */

import { createHash } from "node:crypto";

import { isValidStableId, parseGraphDescriptorShape } from "./schema.js";
import type {
  GraphDescriptor,
  GraphDescriptorInput,
  GraphEdge,
  GraphFanOutEdge,
  GraphNode,
  SealedGraphDescriptor,
} from "./types.js";

const DESCRIPTOR_HASH_PATTERN = /^[a-f0-9]{64}$/;

export class GraphDescriptorValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid graph descriptor: ${issues.join("; ")}`);
    this.name = "GraphDescriptorValidationError";
    this.issues = issues;
  }
}

/** True only for null-prototype or plain `Object.prototype` objects. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Serialize JSON values with object keys sorted recursively in lexical order.
 * Strict current-dev semantics: compact output, arrays in given order; throws
 * `TypeError` on `undefined`, non-finite numbers, symbols, functions, bigints,
 * non-plain objects (Date/Map/Set/RegExp/class instances), and cyclic values.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>());
}

function serializeCanonical(value: unknown, seen: Set<object>): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON requires finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new TypeError("Canonical JSON rejects cyclic values");
    seen.add(value);
    const serialized = `[${value.map((item) => serializeCanonical(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new TypeError("Canonical JSON requires plain objects");
    }
    if (seen.has(value))
      throw new TypeError("Canonical JSON rejects cyclic values");
    seen.add(value);
    const record = value as Record<string, unknown>;
    const serialized = `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeCanonical(record[key], seen)}`,
      )
      .join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  throw new TypeError(
    `Canonical JSON requires JSON-compatible values (got ${typeof value})`,
  );
}

/** Hash payload: the nine contract fields; excludes `descriptor_hash` and runtime fields. */
function descriptorHashPayload(
  input: GraphDescriptorInput,
): Omit<GraphDescriptorInput, "descriptor_hash"> {
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

/** Lowercase SHA-256 hex over the canonical compact JSON of the hash payload. */
export function computeDescriptorHash(input: GraphDescriptorInput): string {
  return createHash("sha256")
    .update(canonicalJson(descriptorHashPayload(input)))
    .digest("hex");
}

/** Recursively freeze an owned value (descriptors are trees; no cycles). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function isRecordWithHash(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "descriptor_hash" in input
  );
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) found.add(value);
    seen.add(value);
  }
  return [...found].sort();
}

function groupByFrom(edges: readonly GraphEdge[]): Map<string, GraphEdge[]> {
  const result = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const group = result.get(edge.from) ?? [];
    group.push(edge);
    result.set(edge.from, group);
  }
  return result;
}

function adjacencyFor(
  edges: readonly GraphEdge[],
  includeBackEdges: boolean,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    if (!includeBackEdges && edge.kind === "back_edge") continue;
    const targets = result.get(edge.from) ?? [];
    targets.push(edge.to);
    result.set(edge.from, targets);
  }
  return result;
}

function isReachable(
  start: string,
  target: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
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

function reachableSet(
  starts: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): Set<string> {
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

/** Detect a cycle among non-back edges; returns the cycle path or undefined. */
function findForwardCycle(
  nodeIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
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
  readonly fanOutNodeId: string;
  readonly joinNodeId: string;
  readonly branchId: string;
  readonly startNodeId: string;
  readonly nodes: Set<string>;
}

/** Nodes reachable from the branch start without passing through the owning join. */
function collectBranchRegion(
  startNodeId: string,
  allAdjacency: ReadonlyMap<string, readonly string[]>,
  joinNodeId: string,
): Set<string> {
  const pending = [startNodeId];
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
  nodes: ReadonlyMap<string, GraphNode>,
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>,
  issues: string[],
): void {
  for (const node of descriptor.nodes) {
    const edges = outgoing.get(node.id) ?? [];
    if (node.id === descriptor.terminal_verification_node_id) {
      if (edges.length > 0) {
        issues.push(
          `terminal verification node ${node.id} must not have outgoing edges`,
        );
      }
      continue;
    }
    if (node.kind === "human-approval") {
      if (edges.length !== 1 || edges[0].kind !== "fixed") {
        issues.push(
          `human-approval node ${node.id} must have exactly one fixed outgoing edge`,
        );
      }
      continue;
    }
    if (node.kind === "join") {
      if (edges.length !== 1 || edges[0].kind !== "fixed") {
        issues.push(
          `join node ${node.id} must have exactly one fixed outgoing edge`,
        );
      }
      continue;
    }
    if (edges.length === 0) {
      issues.push(
        `node ${node.id} cannot reach terminal verification because it has no outgoing edge`,
      );
      continue;
    }
    // A node whose only outgoing edge(s) are back_edges has no forward exit:
    // once max_traversals is exhausted the result is permanently uncommittable.
    if (edges.every((edge) => edge.kind === "back_edge")) {
      issues.push(
        `node ${node.id} has no non-back-edge exit; a back-edge-only node wedges once max_traversals is exhausted`,
      );
    }

    const kinds = new Set(edges.map((edge) => edge.kind));
    if (kinds.has("fixed") && (edges.length !== 1 || kinds.size !== 1)) {
      issues.push(
        `node ${node.id} must use one fixed edge or an explicit route/fan-out set`,
      );
    }
    if (kinds.has("fan_out")) {
      if (kinds.size !== 1 || edges.length < 2) {
        issues.push(
          `fan-out node ${node.id} must declare at least two fan_out edges and no other edge kind`,
        );
      }
    } else if (!kinds.has("fixed")) {
      if (
        [...kinds].some(
          (kind) => kind !== "conditional" && kind !== "back_edge",
        )
      ) {
        issues.push(
          `node ${node.id} has an unsupported routed edge combination`,
        );
      }
      const routes = edges
        .filter(
          (edge): edge is Extract<GraphEdge, { route: string }> =>
            "route" in edge,
        )
        .map((edge) => edge.route);
      const repeatedRoutes = duplicates(routes);
      if (repeatedRoutes.length > 0) {
        issues.push(
          `node ${node.id} declares duplicate route(s): ${repeatedRoutes.join(", ")}`,
        );
      }
    }
  }

  for (const edge of descriptor.edges) {
    if (!nodes.has(edge.from)) {
      issues.push(
        `edge ${edge.id} references missing source node ${edge.from}`,
      );
    }
    if (!nodes.has(edge.to)) {
      issues.push(`edge ${edge.id} references missing target node ${edge.to}`);
    }
  }
}

function validateForkRegions(
  descriptor: GraphDescriptor,
  nodes: ReadonlyMap<string, GraphNode>,
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>,
  allAdjacency: ReadonlyMap<string, readonly string[]>,
  issues: string[],
): ForkBranchRegion[] {
  const fanGroups = new Map<string, GraphFanOutEdge[]>();
  const branchOwners = new Map<string, string>();
  for (const edge of descriptor.edges) {
    if (edge.kind !== "fan_out") continue;
    const group = fanGroups.get(edge.from) ?? [];
    group.push(edge);
    fanGroups.set(edge.from, group);
    const existing = branchOwners.get(edge.branch_id);
    if (existing !== undefined && existing !== edge.from) {
      issues.push(
        `branch ID ${edge.branch_id} is reused by fan-out nodes ${existing} and ${edge.from}`,
      );
    } else if (existing === undefined) {
      branchOwners.set(edge.branch_id, edge.from);
    }
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
    if (joinNode?.kind !== "join") {
      issues.push(
        `fan-out node ${fanOutNodeId} references non-join owner ${joinNodeId}`,
      );
      continue;
    }
    if (joinNode.fan_out_node_id !== fanOutNodeId) {
      issues.push(
        `join ${joinNodeId} does not bind fan-out node ${fanOutNodeId}`,
      );
    }
    const branchIds = fanEdges.map((edge) => edge.branch_id);
    const repeatedBranches = duplicates(branchIds);
    if (repeatedBranches.length > 0) {
      issues.push(
        `fan-out node ${fanOutNodeId} repeats branch ID(s): ${repeatedBranches.join(", ")}`,
      );
    }
    if (
      [...new Set(branchIds)].sort().join("\0") !==
      [...new Set(joinNode.input_branch_ids)].sort().join("\0")
    ) {
      issues.push(
        `join ${joinNodeId} input branches do not match fan-out ${fanOutNodeId}`,
      );
    }
    const repeatedJoinBranches = duplicates(joinNode.input_branch_ids);
    if (repeatedJoinBranches.length > 0) {
      issues.push(`join ${joinNodeId} repeats an input branch ID`);
    }

    const groupRegions: ForkBranchRegion[] = fanEdges.map((edge) => ({
      fanOutNodeId,
      joinNodeId,
      branchId: edge.branch_id,
      startNodeId: edge.to,
      nodes: collectBranchRegion(edge.to, allAdjacency, joinNodeId),
    }));
    regions.push(...groupRegions);

    for (const region of groupRegions) {
      if (!region.nodes.has(region.startNodeId)) {
        issues.push(`fork branch ${region.branchId} has no region`);
      }
      if (!isReachable(region.startNodeId, joinNodeId, allAdjacency)) {
        issues.push(
          `fork branch ${region.branchId} cannot reach owning join ${joinNodeId}`,
        );
      }
      for (const nodeId of region.nodes) {
        const node = nodes.get(nodeId);
        if (node?.kind === "join" && nodeId !== joinNodeId) {
          issues.push(
            `nested join ${nodeId} is not allowed inside fork region ${fanOutNodeId}`,
          );
        }
        if (
          (outgoing.get(nodeId) ?? []).some((edge) => edge.kind === "fan_out")
        ) {
          issues.push(
            `nested fan-out ${nodeId} is not allowed inside fork region ${fanOutNodeId}`,
          );
        }
        if (!isReachable(nodeId, joinNodeId, allAdjacency)) {
          issues.push(
            `fork branch ${region.branchId} contains node ${nodeId} that cannot reach its join`,
          );
        }
      }
      const hasDeclaredJoinInput = descriptor.edges.some(
        (edge) => region.nodes.has(edge.from) && edge.to === joinNodeId,
      );
      if (!hasDeclaredJoinInput) {
        issues.push(
          `fork branch ${region.branchId} has no declared join input`,
        );
      }
    }

    for (let left = 0; left < groupRegions.length; left += 1) {
      for (let right = left + 1; right < groupRegions.length; right += 1) {
        const overlap = [...groupRegions[left].nodes].filter((id) =>
          groupRegions[right].nodes.has(id),
        );
        if (overlap.length > 0) {
          issues.push(
            `fork branches ${groupRegions[left].branchId} and ${groupRegions[right].branchId} overlap at ${overlap.join(", ")}`,
          );
        }
      }
    }
  }

  for (const node of descriptor.nodes) {
    if (node.kind === "join" && !fanGroups.has(node.fan_out_node_id)) {
      issues.push(
        `join ${node.id} has no matching fan-out node ${node.fan_out_node_id}`,
      );
    }
  }

  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      if (regions[left].fanOutNodeId === regions[right].fanOutNodeId) continue;
      const overlap = [...regions[left].nodes].some((id) =>
        regions[right].nodes.has(id),
      );
      if (overlap) {
        issues.push(
          `fork regions ${regions[left].fanOutNodeId} and ${regions[right].fanOutNodeId} overlap or nest`,
        );
      }
    }
  }

  for (const region of regions) {
    for (const edge of descriptor.edges) {
      if (
        edge.kind === "fan_out" &&
        edge.from === region.fanOutNodeId &&
        edge.branch_id === region.branchId
      ) {
        continue;
      }
      const fromInside = region.nodes.has(edge.from);
      const toInside = region.nodes.has(edge.to);
      if (!fromInside && toInside) {
        issues.push(
          `edge ${edge.id} crosses into fork branch ${region.branchId}`,
        );
      }
      if (fromInside && !toInside && edge.to !== region.joinNodeId) {
        issues.push(
          `edge ${edge.id} crosses out of fork branch ${region.branchId}`,
        );
      }
      if (edge.kind === "back_edge" && fromInside !== toInside) {
        issues.push(
          `back-edge ${edge.id} crosses fork region ${region.fanOutNodeId}`,
        );
      }
    }
  }

  for (const node of descriptor.nodes) {
    if (node.kind !== "join") continue;
    const ownerRegions = regions.filter(
      (region) => region.joinNodeId === node.id,
    );
    for (const edge of descriptor.edges.filter(
      (candidate) => candidate.to === node.id,
    )) {
      if (!ownerRegions.some((region) => region.nodes.has(edge.from))) {
        issues.push(
          `edge ${edge.id} enters join ${node.id} outside its owning fork region`,
        );
      }
    }
  }

  return regions;
}

function validateEntryEligibility(
  descriptor: GraphDescriptor,
  nodes: ReadonlyMap<string, GraphNode>,
  regions: readonly ForkBranchRegion[],
  issues: string[],
): void {
  for (const entry of descriptor.entry_node_ids) {
    const node = nodes.get(entry);
    if (node === undefined) continue; // existence already reported
    if (node.kind === "join") {
      issues.push(`entry node ${entry} must not be a join node`);
    } else if (regions.some((region) => region.nodes.has(entry))) {
      issues.push(
        `entry node ${entry} must not be inside a fork branch region`,
      );
    }
  }
}

/**
 * Structural validation. Throws `GraphDescriptorValidationError` with the
 * joined issue list; returns the descriptor unchanged on success.
 */
export function validateGraphDescriptor(
  descriptor: GraphDescriptor,
): GraphDescriptor {
  const issues: string[] = [];

  const repeatedNodeIds = duplicates(descriptor.nodes.map((node) => node.id));
  if (repeatedNodeIds.length > 0) {
    issues.push(`duplicate node ID(s): ${repeatedNodeIds.join(", ")}`);
  }
  const repeatedEdgeIds = duplicates(descriptor.edges.map((edge) => edge.id));
  if (repeatedEdgeIds.length > 0) {
    issues.push(`duplicate edge ID(s): ${repeatedEdgeIds.join(", ")}`);
  }
  const repeatedEntries = duplicates(descriptor.entry_node_ids);
  if (repeatedEntries.length > 0) {
    issues.push(`duplicate entry node ID(s): ${repeatedEntries.join(", ")}`);
  }

  const invalidIds: string[] = [];
  for (const node of descriptor.nodes) {
    if (!isValidStableId(node.id)) invalidIds.push(node.id);
    if (node.kind === "join") {
      if (!isValidStableId(node.fan_out_node_id))
        invalidIds.push(node.fan_out_node_id);
      for (const branchId of node.input_branch_ids) {
        if (!isValidStableId(branchId)) invalidIds.push(branchId);
      }
    }
  }
  for (const edge of descriptor.edges) {
    if (!isValidStableId(edge.id)) invalidIds.push(edge.id);
    if (!isValidStableId(edge.from)) invalidIds.push(edge.from);
    if (!isValidStableId(edge.to)) invalidIds.push(edge.to);
    if (edge.kind === "conditional" || edge.kind === "back_edge") {
      if (!isValidStableId(edge.route)) invalidIds.push(edge.route);
    }
    if (edge.kind === "fan_out") {
      if (!isValidStableId(edge.branch_id)) invalidIds.push(edge.branch_id);
      if (!isValidStableId(edge.owner_join_id))
        invalidIds.push(edge.owner_join_id);
    }
  }
  for (const entry of descriptor.entry_node_ids) {
    if (!isValidStableId(entry)) invalidIds.push(entry);
  }
  if (!isValidStableId(descriptor.terminal_verification_node_id)) {
    invalidIds.push(descriptor.terminal_verification_node_id);
  }
  if (invalidIds.length > 0) {
    issues.push(
      `invalid stable ID(s): ${[...new Set(invalidIds)].sort().join(", ")}`,
    );
  }

  const nodes = new Map<string, GraphNode>(
    descriptor.nodes.map((node) => [node.id, node] as const),
  );
  const outgoing = groupByFrom(descriptor.edges);
  validateOutgoingContracts(descriptor, nodes, outgoing, issues);

  for (const entry of descriptor.entry_node_ids) {
    if (!nodes.has(entry)) issues.push(`entry node ${entry} does not exist`);
  }
  const terminalNode = nodes.get(descriptor.terminal_verification_node_id);
  if (terminalNode === undefined) {
    issues.push(
      `terminal verification node ${descriptor.terminal_verification_node_id} does not exist`,
    );
  } else if (terminalNode.kind !== "agent" && terminalNode.kind !== "command") {
    issues.push(
      "terminal verification must be an executable agent or command node",
    );
  }

  const allAdjacency = adjacencyFor(descriptor.edges, true);
  const forwardAdjacency = adjacencyFor(descriptor.edges, false);
  const reachable = reachableSet(descriptor.entry_node_ids, allAdjacency);
  const unreachable = descriptor.nodes
    .map((node) => node.id)
    .filter((id) => !reachable.has(id));
  if (unreachable.length > 0) {
    issues.push(`unreachable node(s): ${unreachable.join(", ")}`);
  }

  const cycle = findForwardCycle(
    descriptor.nodes.map((node) => node.id),
    forwardAdjacency,
  );
  if (cycle) {
    issues.push(`non-back-edge cycle detected: ${cycle.join(" -> ")}`);
  }

  for (const edge of descriptor.edges) {
    if (edge.kind === "back_edge") {
      const isReturn =
        edge.to === edge.from ||
        isReachable(edge.to, edge.from, forwardAdjacency);
      if (!isReturn) {
        issues.push(
          `back-edge ${edge.id} is not a structural return to an earlier node`,
        );
      }
    }
  }

  if (terminalNode !== undefined) {
    const cannotVerify = descriptor.nodes
      .map((node) => node.id)
      .filter((id) => !isReachable(id, terminalNode.id, allAdjacency));
    if (cannotVerify.length > 0) {
      issues.push(
        `every successful path must reach terminal verification; failing node(s): ${cannotVerify.join(", ")}`,
      );
    }
  }

  const regions = validateForkRegions(
    descriptor,
    nodes,
    outgoing,
    allAdjacency,
    issues,
  );
  validateEntryEligibility(descriptor, nodes, regions, issues);

  if (issues.length > 0) {
    throw new GraphDescriptorValidationError([...new Set(issues)]);
  }
  return descriptor;
}

/**
 * Draft parser: strict schema parse → full validation → defensive
 * `structuredClone` + `deepFreeze`. Input carrying a `descriptor_hash` is
 * rejected with a directed error (use `parseSealedGraphDescriptor`).
 */
export function parseGraphDescriptor(input: unknown): GraphDescriptor {
  if (isRecordWithHash(input)) {
    throw new GraphDescriptorValidationError([
      "sealed input must use `parseSealedGraphDescriptor`",
    ]);
  }
  const descriptor = validateGraphDescriptor(parseGraphDescriptorShape(input));
  return deepFreeze(structuredClone(descriptor));
}

/**
 * Sole draft → scheduler producer: strict parse → validate → compute hash →
 * defensive `structuredClone` + `deepFreeze` with `descriptor_hash`. Input
 * carrying a `descriptor_hash` is rejected with a directed error.
 */
export function sealGraphDescriptor(input: unknown): SealedGraphDescriptor {
  if (isRecordWithHash(input)) {
    throw new GraphDescriptorValidationError([
      "use `parseSealedGraphDescriptor` for persisted sealed input",
    ]);
  }
  const descriptor = validateGraphDescriptor(parseGraphDescriptorShape(input));
  const sealed: SealedGraphDescriptor = {
    ...structuredClone(descriptor),
    descriptor_hash: computeDescriptorHash(descriptor),
  };
  return deepFreeze(sealed);
}

/**
 * Sole persisted → scheduler producer. Requires a well-formed `descriptor_hash`;
 * strict schema parse → full validation → recompute the hash and compare with
 * the supplied hash; a mismatch is rejected (never silently recomputed), then a
 * defensive `structuredClone` + `deepFreeze` is returned.
 */
export function parseSealedGraphDescriptor(
  input: unknown,
): SealedGraphDescriptor {
  const suppliedHash =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).descriptor_hash
      : undefined;
  if (typeof suppliedHash !== "string") {
    throw new GraphDescriptorValidationError([
      "persisted sealed input must carry a `descriptor_hash`",
    ]);
  }
  if (!DESCRIPTOR_HASH_PATTERN.test(suppliedHash)) {
    throw new GraphDescriptorValidationError([
      "`descriptor_hash` must be 64 lowercase hexadecimal characters",
    ]);
  }
  const descriptor = validateGraphDescriptor(parseGraphDescriptorShape(input));
  if (computeDescriptorHash(descriptor) !== suppliedHash) {
    throw new GraphDescriptorValidationError([
      "descriptor hash does not match the exact revision",
    ]);
  }
  const sealed: SealedGraphDescriptor = {
    ...structuredClone(descriptor),
    descriptor_hash: suppliedHash,
  };
  return deepFreeze(sealed);
}

/**
 * Non-branding, never-throws boolean predicate. Structure-before-hash: strict
 * schema parse → full validation → hash recompute → compare; `false` on any
 * structural failure or mismatch. Does not clone, freeze, or mutate its input.
 */
export function verifyDescriptorHash(input: unknown): boolean {
  try {
    const descriptor = validateGraphDescriptor(
      parseGraphDescriptorShape(input),
    );
    return computeDescriptorHash(descriptor) === descriptor.descriptor_hash;
  } catch {
    return false;
  }
}

/** Non-throwing structural check (shape parse + validation, no hash semantics). */
export function isGraphDescriptor(input: unknown): input is GraphDescriptor {
  try {
    validateGraphDescriptor(parseGraphDescriptorShape(input));
    return true;
  } catch {
    return false;
  }
}
