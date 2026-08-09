/**
 * Graph Core pure deterministic scheduler (stage-04 contract).
 *
 * Contract-authored from the ralplan stage-04 revision (`pending-approval.md`);
 * oracle `99ffe31` used only for behavioral cross-checks. Scheduler accepts only
 * `SealedGraphDescriptor`; projections are descriptor-bound; record-bearing
 * mutations are replay-fenced; begin/release commit nothing.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "./descriptor.js";
import {
  isValidStableId,
  parseGraphApprovalDecision,
  parseGraphNodeResult,
} from "./schema.js";
import type {
  ApplyHumanApprovalInput,
  ApplyNodeResultInput,
  BeginActivationAttemptInput,
  GraphActivation,
  GraphBranchToken,
  GraphCohort,
  GraphCommittedTransition,
  GraphDeniedTransition,
  GraphEdge,
  GraphEvidenceReference,
  GraphFailedTransition,
  GraphJoinResolvedTransition,
  GraphNode,
  GraphSchedulerErrorCode,
  GraphSchedulerProjection,
  GraphSucceededTransition,
  GraphApprovedTransition,
  ReleaseAttemptForRetryInput,
  ResolveJoinInput,
  SchedulerApplyResult,
  SchedulerTransitionIdentities,
  SealedGraphDescriptor,
} from "./types.js";

export class GraphSchedulerError extends Error {
  readonly code: GraphSchedulerErrorCode;
  constructor(code: GraphSchedulerErrorCode, message: string) {
    super(message);
    this.name = "GraphSchedulerError";
    this.code = code;
  }
}

/** Closed-error throw helper: every scheduler failure uses exactly one code. */
function fail(code: GraphSchedulerErrorCode, message: string): never {
  throw new GraphSchedulerError(code, message);
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? `<${typeof value}>`;
  } catch {
    return `<${typeof value}>`;
  }
}
/** Wrap a Zod-validating parser: ZodError never escapes a scheduler entrypoint. */
function parseSchedulerInput<T>(
  parse: (input: unknown) => T,
  input: unknown,
  what: string,
): T {
  try {
    return parse(input);
  } catch (error) {
    fail(
      "invalid_input",
      `invalid ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Prototype-safe own-key lookup for state maps (callers may use plain objects). */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Empty null-prototype map: own-key writes can never hit Object.prototype. */
function emptyMap<T>(): Record<string, T> {
  return Object.create(null);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identityField(
  identities: SchedulerTransitionIdentities | undefined,
  key: "cohort_id" | "join_activation_id",
): string | undefined {
  return identities !== undefined && Object.hasOwn(identities, key)
    ? identities[key]
    : undefined;
}

function identityMapValue(
  map: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

function requireStableId(
  value: unknown,
  what: string,
): asserts value is string {
  if (!isValidStableId(value))
    fail(
      "invalid_input",
      `${what} ${displayValue(value)} is not a stable identifier`,
    );
}

/**
 * Normalize a request for fingerprinting: strip undefined fields into a
 * null-prototype accumulation and reject cycles deterministically. Values are
 * validated strictly by `canonicalJson` afterwards.
 */
function toFingerprintJson(value: unknown, seen: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("cyclic request value");
    seen.add(value);
    const normalized = value.map((item) => toFingerprintJson(item, seen));
    seen.delete(value);
    return normalized;
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("cyclic request value");
    if (!isPlainRecord(value))
      throw new TypeError("request value must be a plain object");
    seen.add(value);
    const normalized: Record<string, unknown> = emptyMap();
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) normalized[key] = toFingerprintJson(child, seen);
    }
    seen.delete(value);
    return normalized;
  }
  return value;
}

/** Versioned replay fingerprint bound to the descriptor hash. */
function requestFingerprint(
  kind: "node_result" | "human_approval" | "resolve_join",
  descriptorHash: string,
  request: unknown,
): string {
  return createHash("sha256")
    .update(
      canonicalJson(
        toFingerprintJson(
          {
            fingerprint_version: 1,
            kind,
            descriptor_hash: descriptorHash,
            request,
          },
          new Set<object>(),
        ),
      ),
    )
    .digest("hex");
}

/** Fingerprint failures (unsupported or cyclic raw values) map to `invalid_input`. */
function computeFingerprint(
  kind: "node_result" | "human_approval" | "resolve_join",
  descriptorHash: string,
  request: unknown,
): string {
  try {
    return requestFingerprint(kind, descriptorHash, request);
  } catch (error) {
    fail(
      "invalid_input",
      `cannot fingerprint request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Locale-independent code-unit ordering for ready lists. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nodeById(
  descriptor: SealedGraphDescriptor,
  nodeId: string,
): GraphNode | undefined {
  return descriptor.nodes.find((node) => node.id === nodeId);
}

function outgoingEdgesOf(
  descriptor: SealedGraphDescriptor,
  nodeId: string,
): GraphEdge[] {
  return descriptor.edges.filter((edge) => edge.from === nodeId);
}

/** All identities in the projection's single global namespace (own keys only). */
function namespaceIds(projection: GraphSchedulerProjection): Set<string> {
  const ids = new Set<string>();
  for (const activation of Object.values(projection.activations)) {
    ids.add(activation.activation_id);
    for (const attemptId of activation.attempt_ids) ids.add(attemptId);
  }
  for (const cohortId of Object.keys(projection.cohorts)) ids.add(cohortId);
  for (const tokenId of Object.keys(projection.branch_tokens)) ids.add(tokenId);
  for (const transitionId of Object.keys(projection.committed_transitions))
    ids.add(transitionId);
  return ids;
}

/** Descriptor binding: hash AND run/revision must match the projection. */
function fenceDescriptor(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
): void {
  if (!isPlainRecord(projection))
    fail("invalid_input", "projection must be a plain object");
  if (
    typeof projection.descriptor_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(projection.descriptor_hash) ||
    !isValidStableId(projection.run_id) ||
    !isValidStableId(projection.revision_id)
  )
    fail("invalid_input", "projection descriptor binding is malformed");
  if (
    projection.descriptor_hash !== descriptor.descriptor_hash ||
    projection.run_id !== descriptor.run_id ||
    projection.revision_id !== descriptor.revision_id
  ) {
    fail(
      "descriptor_mismatch",
      `projection bound to ${displayValue(projection.run_id)}/${displayValue(projection.revision_id)}/${displayValue(projection.descriptor_hash)}, not ${descriptor.run_id}/${descriptor.revision_id}/${descriptor.descriptor_hash}`,
    );
  }
}

interface MutableGraphSchedulerProjection {
  descriptor_hash: string;
  run_id: string;
  revision_id: string;
  activations: Record<string, GraphActivation>;
  cohorts: Record<string, GraphCohort>;
  branch_tokens: Record<string, GraphBranchToken>;
  traversal_counts: Record<string, number>;
  committed_transitions: Record<string, GraphCommittedTransition>;
  terminal_verification_activation_ids: string[];
}

function cloneMap<T>(
  map: Readonly<Record<string, T>>,
  copy: (value: T) => T,
): Record<string, T> {
  const result = emptyMap<T>();
  for (const [key, value] of Object.entries(map)) result[key] = copy(value);
  return result;
}

/** Structural deep clone; the scheduler never mutates its input projection. */
function cloneProjection(
  projection: GraphSchedulerProjection,
): MutableGraphSchedulerProjection {
  try {
    return {
      descriptor_hash: projection.descriptor_hash,
      run_id: projection.run_id,
      revision_id: projection.revision_id,
      activations: cloneMap(projection.activations, (a) => ({
        ...a,
        attempt_ids: [...a.attempt_ids],
      })),
      cohorts: cloneMap(projection.cohorts, (c) => ({
        ...c,
        expected_branch_token_ids: [...c.expected_branch_token_ids],
      })),
      branch_tokens: cloneMap(projection.branch_tokens, (t) => ({ ...t })),
      traversal_counts: Object.assign(
        Object.create(null),
        projection.traversal_counts,
      ),
      committed_transitions: cloneMap(
        projection.committed_transitions,
        (transition) => structuredClone(transition),
      ),
      terminal_verification_activation_ids: [
        ...projection.terminal_verification_activation_ids,
      ],
    };
  } catch {
    fail(
      "invalid_input",
      "projection contains malformed or non-cloneable values",
    );
  }
}

/**
 * Identity maps must key by the context node's declared outgoing edge IDs.
 * Unknown keys → `undeclared_identity_key`; malformed values → `invalid_input`.
 * Runs BEFORE fingerprinting so fingerprints cover only validated identities.
 */
function validateIdentities(
  descriptor: SealedGraphDescriptor,
  node: GraphNode,
  identities: SchedulerTransitionIdentities | undefined,
): void {
  if (identities === undefined) return;
  if (!isPlainRecord(identities))
    fail("invalid_input", "identities must be a plain object");
  const allowedKeys = new Set([
    "next_activation_ids",
    "cohort_id",
    "branch_token_ids",
    "join_activation_id",
  ]);
  for (const key of Object.keys(identities)) {
    if (!allowedKeys.has(key))
      fail("invalid_input", `identities contains unknown field ${key}`);
  }
  const declaredEdges = new Set(
    outgoingEdgesOf(descriptor, node.id).map((edge) => edge.id),
  );
  const validateKeys = (map: unknown, what: string): void => {
    if (map === undefined) return;
    if (!isPlainRecord(map))
      fail("invalid_input", `${what} must be a plain object`);
    for (const [key, value] of Object.entries(map)) {
      if (!declaredEdges.has(key))
        fail(
          "undeclared_identity_key",
          `${what} key ${key} is not a declared outgoing edge of node ${node.id}`,
        );
      if (!isValidStableId(value))
        fail(
          "invalid_input",
          `${what} value ${displayValue(value)} is not a stable identifier`,
        );
    }
  };
  validateKeys(identities.next_activation_ids, "next_activation_ids");
  validateKeys(identities.branch_token_ids, "branch_token_ids");
  for (const value of [
    identityField(identities, "cohort_id"),
    identityField(identities, "join_activation_id"),
  ]) {
    if (value !== undefined && !isValidStableId(value))
      fail(
        "invalid_input",
        `${displayValue(value)} is not a stable identifier`,
      );
  }
}

/** Replay fence for the three record-bearing mutations. */
function replayFence(
  projection: GraphSchedulerProjection,
  transitionId: string,
  fingerprint: string,
): GraphCommittedTransition | undefined {
  const existing = own(projection.committed_transitions, transitionId);
  if (existing === undefined) return undefined;
  if (existing.request_fingerprint !== fingerprint) {
    fail(
      "transition_fenced",
      `transition ${transitionId} was committed with a different request fingerprint`,
    );
  }
  return existing;
}

/** Reserve a fresh id against the global namespace; throws `duplicate_identity`. */
function assertFreshId(
  projection: GraphSchedulerProjection,
  id: string,
  what: string,
): void {
  if (namespaceIds(projection).has(id)) {
    fail(
      "duplicate_identity",
      `${what} ${id} collides with an existing identity in the global namespace`,
    );
  }
}

function requireActivation(
  projection: GraphSchedulerProjection,
  activationId: string,
): GraphActivation {
  requireStableId(activationId, "activation id");
  const activation = own(projection.activations, activationId);
  if (activation === undefined)
    fail(
      "activation_not_found",
      `activation ${displayValue(activationId)} not found`,
    );
  requireStableId(activation.activation_id, "stored activation id");
  requireStableId(activation.node_id, "stored node id");
  requireStableId(activation.traversal_owner_id, "stored traversal owner id");
  if (
    !Array.isArray(activation.attempt_ids) ||
    !activation.attempt_ids.every(isValidStableId)
  )
    fail("invalid_input", "stored activation attempt_ids are malformed");
  if (activation.active_attempt_id !== undefined)
    requireStableId(activation.active_attempt_id, "stored active attempt id");
  return activation;
}

function requireNode(
  descriptor: SealedGraphDescriptor,
  nodeId: string,
): GraphNode {
  const node = nodeById(descriptor, nodeId);
  if (node === undefined) fail("node_not_found", `node ${nodeId} not found`);
  return node;
}

/** Post-replay transition-id guard shared by the three record-bearing mutations. */
function guardTransitionId(
  projection: GraphSchedulerProjection,
  transitionId: string,
): void {
  if (!isValidStableId(transitionId))
    fail(
      "invalid_input",
      `transition id ${displayValue(transitionId)} is not a stable identifier`,
    );
  assertFreshId(projection, transitionId, "transition id");
}

/**
 * Mutation-local identity reservation. The transition id joins the same
 * namespace as every activation/cohort/token/join id created by the mutation,
 * so same-mutation collisions throw `duplicate_identity`.
 */
function reservation(
  projection: GraphSchedulerProjection,
  transitionId: string,
): { reserve: (id: string, what: string) => void } {
  const reserved = new Set<string>([transitionId]);
  return {
    reserve: (id: string, what: string): void => {
      if (namespaceIds(projection).has(id) || reserved.has(id)) {
        fail(
          "duplicate_identity",
          `${what} ${id} collides with an existing identity or this mutation's transition ${transitionId}`,
        );
      }
      reserved.add(id);
    },
  };
}

/** Fields shared by every committed transition record. */
function transitionCommon(
  input: { activation_id: string; transition_id: string },
  node: GraphNode,
  fingerprint: string,
  descriptor: SealedGraphDescriptor,
) {
  return {
    transition_id: input.transition_id,
    activation_id: input.activation_id,
    node_id: node.id,
    fingerprint_version: 1,
    request_fingerprint: fingerprint,
    descriptor_hash: descriptor.descriptor_hash,
  } as const;
}

/** Evidence tuple required by approved/denied records (caller pre-checked non-empty). */
function nonEmptyEvidence(
  refs: readonly GraphEvidenceReference[],
): [GraphEvidenceReference, ...GraphEvidenceReference[]] {
  return [...refs] as [GraphEvidenceReference, ...GraphEvidenceReference[]];
}

/**
 * Create a ready activation for `nodeId`, inheriting the traversal lineage and
 * (when inside a fork branch) the branch token from the source activation.
 */
function createNextActivation(
  next: MutableGraphSchedulerProjection,
  activationId: string,
  nodeId: string,
  source: GraphActivation,
  descriptor: SealedGraphDescriptor,
  extra?: { readonly cohort_id?: string; readonly branch_token_id?: string },
): GraphActivation {
  const branchTokenId =
    extra !== undefined && Object.hasOwn(extra, "branch_token_id")
      ? extra.branch_token_id
      : source.branch_token_id;
  const created: GraphActivation = {
    activation_id: activationId,
    node_id: nodeId,
    status: "ready",
    attempt_no: 0,
    attempt_ids: [],
    traversal_owner_id: source.traversal_owner_id,
    ...(branchTokenId !== undefined && { branch_token_id: branchTokenId }),
    ...(extra?.cohort_id !== undefined && { cohort_id: extra.cohort_id }),
  };
  next.activations[activationId] = created;
  if (nodeId === descriptor.terminal_verification_node_id)
    next.terminal_verification_activation_ids.push(activationId);
  const tokenId = created.branch_token_id;
  if (tokenId !== undefined) {
    const token = own(next.branch_tokens, tokenId);
    if (token !== undefined && token.status === "active") {
      next.branch_tokens[tokenId] = {
        ...token,
        current_activation_id: activationId,
      };
    }
  }
  return created;
}

/** Create the initial descriptor-bound projection with entry activations. */
export function initializeGraphProjection(
  descriptor: SealedGraphDescriptor,
  entryActivationIds: Readonly<Record<string, string>>,
): GraphSchedulerProjection {
  if (!isPlainRecord(entryActivationIds))
    fail("invalid_input", "entry activation identities must be a plain object");
  const entrySet = new Set(descriptor.entry_node_ids);
  for (const key of Object.keys(entryActivationIds)) {
    if (!entrySet.has(key))
      fail(
        "unexpected_identity",
        `identity supplied for non-entry node ${key}`,
      );
  }
  for (const entry of descriptor.entry_node_ids) {
    if (!Object.hasOwn(entryActivationIds, entry))
      fail(
        "missing_identity",
        `missing activation identity for entry node ${entry}`,
      );
  }
  const activations: Record<string, GraphActivation> = emptyMap();
  const terminalVerificationActivationIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of descriptor.entry_node_ids) {
    const activationId = identityMapValue(entryActivationIds, entry);
    requireStableId(activationId, "activation id");
    if (seen.has(activationId))
      fail(
        "duplicate_identity",
        `activation identity ${activationId} used more than once`,
      );
    seen.add(activationId);
    activations[activationId] = {
      activation_id: activationId,
      node_id: entry,
      status: "ready",
      attempt_no: 0,
      attempt_ids: [],
      traversal_owner_id: activationId,
    };
    if (entry === descriptor.terminal_verification_node_id)
      terminalVerificationActivationIds.push(activationId);
  }
  return {
    descriptor_hash: descriptor.descriptor_hash,
    run_id: descriptor.run_id,
    revision_id: descriptor.revision_id,
    activations,
    cohorts: emptyMap(),
    branch_tokens: emptyMap(),
    traversal_counts: emptyMap(),
    committed_transitions: emptyMap(),
    terminal_verification_activation_ids: terminalVerificationActivationIds,
  };
}

/** Plain projection transform; commits no transition record. */
export function beginActivationAttempt(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  input: BeginActivationAttemptInput,
): GraphSchedulerProjection {
  fenceDescriptor(descriptor, projection);
  requireStableId(input.activation_id, "activation id");
  requireStableId(input.attempt_id, "attempt id");
  const activation = requireActivation(projection, input.activation_id);
  if (activation.status !== "ready")
    fail(
      "activation_not_ready",
      `activation ${input.activation_id} is not ready`,
    );
  const node = requireNode(descriptor, activation.node_id);
  if (node.kind !== "agent" && node.kind !== "command")
    fail(
      "unsupported_node_kind",
      `node ${node.id} of kind ${node.kind} cannot begin an attempt`,
    );
  if (activation.attempt_no >= node.max_attempts)
    fail(
      "max_attempts_exceeded",
      `activation ${input.activation_id} already used its budget of ${node.max_attempts} attempts`,
    );
  if (!isValidStableId(input.attempt_id))
    fail(
      "invalid_input",
      `attempt id ${displayValue(input.attempt_id)} is not a stable identifier`,
    );
  assertFreshId(projection, input.attempt_id, "attempt id");
  const nextProjection = cloneProjection(projection);
  nextProjection.activations[input.activation_id] = {
    ...activation,
    status: "running",
    attempt_no: activation.attempt_no + 1,
    attempt_ids: [...activation.attempt_ids, input.attempt_id],
    active_attempt_id: input.attempt_id,
  };
  return nextProjection;
}

/**
 * Atomic final-budget release: if `attempt_no >= node.max_attempts` at release
 * time the activation goes terminal `failed` (never an unstartable ready state);
 * otherwise it returns to `ready`. Plain projection transform; no record.
 */
export function releaseAttemptForRetry(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  input: ReleaseAttemptForRetryInput,
): GraphSchedulerProjection {
  fenceDescriptor(descriptor, projection);
  requireStableId(input.activation_id, "activation id");
  requireStableId(input.attempt_id, "attempt id");
  const activation = requireActivation(projection, input.activation_id);
  if (
    activation.status !== "running" ||
    activation.active_attempt_id !== input.attempt_id
  )
    fail(
      "attempt_fenced",
      `activation ${input.activation_id} is not running attempt ${input.attempt_id}`,
    );
  const node = requireNode(descriptor, activation.node_id);
  if (node.kind !== "agent" && node.kind !== "command")
    fail(
      "unsupported_node_kind",
      `node ${node.id} of kind ${node.kind} cannot release an attempt`,
    );
  const nextProjection = cloneProjection(projection);
  nextProjection.activations[input.activation_id] = {
    ...activation,
    status: activation.attempt_no >= node.max_attempts ? "failed" : "ready",
    active_attempt_id: undefined,
  };
  return nextProjection;
}

/** Record-bearing mutation for agent/command completion (replay-fenced). */
export function applyNodeResult(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  input: ApplyNodeResultInput,
): SchedulerApplyResult {
  fenceDescriptor(descriptor, projection);
  requireStableId(input.activation_id, "activation id");
  const result = parseSchedulerInput(
    parseGraphNodeResult,
    input.result,
    "node result",
  );
  const activation = requireActivation(projection, input.activation_id);
  const node = requireNode(descriptor, activation.node_id);
  if (node.kind === "human-approval")
    fail(
      "approval_requires_dedicated_transition",
      `node ${node.id} requires applyHumanApproval`,
    );
  if (node.kind === "join")
    fail("join_is_automatic", `node ${node.id} is resolved by the scheduler`);
  validateIdentities(descriptor, node, input.identities);
  const fingerprint = computeFingerprint(
    "node_result",
    descriptor.descriptor_hash,
    {
      activation_id: input.activation_id,
      transition_id: input.transition_id,
      result,
      identities: input.identities,
    },
  );
  const existing = replayFence(projection, input.transition_id, fingerprint);
  if (existing !== undefined)
    return { projection, transition: existing, replayed: true };
  if (
    activation.status !== "running" ||
    activation.active_attempt_id !== result.attempt_id
  )
    fail(
      "attempt_fenced",
      `activation ${input.activation_id} is not running attempt ${result.attempt_id}`,
    );
  guardTransitionId(projection, input.transition_id);
  const edges = outgoingEdgesOf(descriptor, node.id);
  const edgeMode =
    result.outcome === "failed"
      ? "failed"
      : edges.length === 0
        ? "terminal"
        : edges.some((e) => e.kind === "fan_out")
          ? "fan_out"
          : edges.some((e) => e.kind === "fixed")
            ? "fixed"
            : "routed";

  if (edgeMode === "failed") {
    if (result.route !== undefined)
      fail("undeclared_route", "failed results cannot select routes");
    const next = cloneProjection(projection);
    next.activations[input.activation_id] = {
      ...activation,
      status: activation.attempt_no >= node.max_attempts ? "failed" : "ready",
      active_attempt_id: undefined,
    };
    const transition: GraphFailedTransition = {
      ...transitionCommon(input, node, fingerprint, descriptor),
      outcome: "failed",
      selected_edge_ids: [],
      created_activation_ids: [],
      evidence_refs: [...result.evidence_refs],
      attempt_id: result.attempt_id,
      ...(result.output_summary !== undefined && {
        output_summary: result.output_summary,
      }),
      ...(result.external_idempotency_key !== undefined && {
        external_idempotency_key: result.external_idempotency_key,
      }),
    };
    next.committed_transitions[input.transition_id] = transition;
    return { projection: next, transition, replayed: false };
  }

  if (
    node.id === descriptor.terminal_verification_node_id &&
    result.evidence_refs.length === 0
  )
    fail(
      "terminal_evidence_required",
      `terminal verification node ${node.id} requires at least one evidence reference`,
    );

  let selectedEdgeIds: string[] = [];
  let createdActivationIds: string[] = [];
  let cohortId: string | undefined;
  let matchedEdge: GraphEdge | undefined;
  const next = cloneProjection(projection);
  const { reserve } = reservation(next, input.transition_id);

  if (edgeMode === "fan_out") {
    if (result.route !== undefined)
      fail("undeclared_route", `node ${node.id} declares no routes`);
    const fanEdges = edges.filter(
      (e): e is Extract<GraphEdge, { kind: "fan_out" }> => e.kind === "fan_out",
    );
    if (fanEdges.length < 2)
      fail(
        "invalid_input",
        `fan-out node ${node.id} has fewer than two fan_out edges`,
      );
    cohortId = identityField(input.identities, "cohort_id");
    if (cohortId === undefined)
      fail(
        "missing_identity",
        `fan-out node ${node.id} requires identities.cohort_id`,
      );
    reserve(cohortId, "cohort id");
    const entries = fanEdges.map((fanEdge) => {
      const tokenId = identityMapValue(
        input.identities?.branch_token_ids,
        fanEdge.id,
      );
      const branchActivationId = identityMapValue(
        input.identities?.next_activation_ids,
        fanEdge.id,
      );
      if (tokenId === undefined)
        fail(
          "missing_identity",
          `fan-out node ${node.id} requires branch_token_ids[${fanEdge.id}]`,
        );
      if (branchActivationId === undefined)
        fail(
          "missing_identity",
          `fan-out node ${node.id} requires next_activation_ids[${fanEdge.id}]`,
        );
      reserve(tokenId, "branch token id");
      reserve(branchActivationId, "activation id");
      return { fanEdge, tokenId, branchActivationId };
    });
    next.cohorts[cohortId] = {
      cohort_id: cohortId,
      fan_out_node_id: node.id,
      owner_join_id: fanEdges[0].owner_join_id,
      expected_branch_token_ids: entries.map((e) => e.tokenId),
      consumed: false,
    };
    for (const entry of entries) {
      next.branch_tokens[entry.tokenId] = {
        branch_token_id: entry.tokenId,
        cohort_id: cohortId,
        branch_id: entry.fanEdge.branch_id,
        owner_join_id: fanEdges[0].owner_join_id,
        status: "active",
        current_activation_id: entry.branchActivationId,
      };
      createNextActivation(
        next,
        entry.branchActivationId,
        entry.fanEdge.to,
        activation,
        descriptor,
        { branch_token_id: entry.tokenId },
      );
    }
    selectedEdgeIds = fanEdges.map((e) => e.id);
    createdActivationIds = entries.map((e) => e.branchActivationId);
  } else if (edgeMode === "fixed" || edgeMode === "routed") {
    if (edgeMode === "fixed") {
      if (result.route !== undefined)
        fail("undeclared_route", `node ${node.id} declares no routes`);
      matchedEdge = edges.find((e) => e.kind === "fixed");
    } else {
      if (result.route === undefined)
        fail("route_required", `node ${node.id} requires a declared route`);
      matchedEdge = edges.find(
        (e) =>
          (e.kind === "conditional" || e.kind === "back_edge") &&
          e.route === result.route,
      );
      if (matchedEdge === undefined)
        fail(
          "undeclared_route",
          `node ${node.id} declares no route ${result.route}`,
        );
    }
  } else if (result.route !== undefined) {
    fail("undeclared_route", `node ${node.id} declares no routes`); // terminal node
  }

  next.activations[input.activation_id] = {
    ...activation,
    status: "completed",
    completed_transition_id: input.transition_id,
  };

  if (matchedEdge !== undefined) {
    selectedEdgeIds = [matchedEdge.id];
    const targetNode = nodeById(descriptor, matchedEdge.to);
    if (matchedEdge.kind === "back_edge") {
      const counterKey = traversalCounterKey(activation, matchedEdge);
      const count = next.traversal_counts[counterKey] ?? 0;
      if (count + 1 > matchedEdge.max_traversals)
        fail(
          "traversal_bound_exceeded",
          `back-edge ${matchedEdge.id} exceeded its max_traversals of ${matchedEdge.max_traversals}`,
        );
      next.traversal_counts[counterKey] = count + 1;
      const nextActivationId = requireNextActivationId(
        input.identities,
        matchedEdge,
      );
      reserve(nextActivationId, "activation id");
      createNextActivation(
        next,
        nextActivationId,
        matchedEdge.to,
        activation,
        descriptor,
      );
      createdActivationIds = [nextActivationId];
    } else if (targetNode?.kind === "join") {
      const token = activation.branch_token_id
        ? own(next.branch_tokens, activation.branch_token_id)
        : undefined;
      if (
        token === undefined ||
        token.status !== "active" ||
        token.current_activation_id !== activation.activation_id
      )
        fail(
          "branch_token_fenced",
          `activation ${input.activation_id} does not own an active branch token for join ${matchedEdge.to}`,
        );
      next.branch_tokens[token.branch_token_id] = {
        ...token,
        status: "arrived",
        current_activation_id: undefined,
      };
      const cohort = own(next.cohorts, token.cohort_id);
      if (cohort === undefined)
        fail(
          "join_owner_missing",
          `cohort ${token.cohort_id} for token ${token.branch_token_id} not found`,
        );
      const allArrived = cohort.expected_branch_token_ids.every(
        (tokenId) => own(next.branch_tokens, tokenId)?.status === "arrived",
      );
      if (allArrived) {
        const joinActivationId = identityField(
          input.identities,
          "join_activation_id",
        );
        if (joinActivationId === undefined)
          fail(
            "missing_identity",
            `join ${matchedEdge.to} requires identities.join_activation_id`,
          );
        reserve(joinActivationId, "activation id");
        createNextActivation(
          next,
          joinActivationId,
          matchedEdge.to,
          activation,
          descriptor,
          { cohort_id: cohort.cohort_id, branch_token_id: undefined },
        );
        next.cohorts[cohort.cohort_id] = {
          ...cohort,
          join_activation_id: joinActivationId,
        };
        createdActivationIds = [joinActivationId];
      }
    } else {
      const nextActivationId = requireNextActivationId(
        input.identities,
        matchedEdge,
      );
      reserve(nextActivationId, "activation id");
      createNextActivation(
        next,
        nextActivationId,
        matchedEdge.to,
        activation,
        descriptor,
      );
      createdActivationIds = [nextActivationId];
    }
  }

  const transition: GraphSucceededTransition = {
    ...transitionCommon(input, node, fingerprint, descriptor),
    outcome: "succeeded",
    selected_edge_ids: selectedEdgeIds,
    created_activation_ids: createdActivationIds,
    evidence_refs: [...result.evidence_refs],
    attempt_id: result.attempt_id,
    ...(result.route !== undefined && { route: result.route }),
    ...(cohortId !== undefined && { cohort_id: cohortId }),
    ...(result.output_summary !== undefined && {
      output_summary: result.output_summary,
    }),
    ...(result.external_idempotency_key !== undefined && {
      external_idempotency_key: result.external_idempotency_key,
    }),
  };
  next.committed_transitions[input.transition_id] = transition;
  return { projection: next, transition, replayed: false };
}

function requireNextActivationId(
  identities: SchedulerTransitionIdentities | undefined,
  edge: GraphEdge,
): string {
  const activationId = identityMapValue(
    identities?.next_activation_ids,
    edge.id,
  );
  if (activationId === undefined)
    fail(
      "missing_identity",
      `edge ${edge.id} requires identities.next_activation_ids[${edge.id}]`,
    );
  return activationId;
}

/**
 * Dedicated human-approval transition. `approved` follows the node's single
 * fixed outgoing edge; `denied` terminal-fails the activation. Records carry
 * `output_summary` (never `summary`) and no `attempt_id`; both outcomes require
 * at least one evidence reference. Replay-fenced.
 */
export function applyHumanApproval(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  input: ApplyHumanApprovalInput,
): SchedulerApplyResult {
  fenceDescriptor(descriptor, projection);
  requireStableId(input.activation_id, "activation id");
  const decision = parseSchedulerInput(
    parseGraphApprovalDecision,
    input.decision,
    "approval decision",
  );
  const activation = requireActivation(projection, input.activation_id);
  const node = requireNode(descriptor, activation.node_id);
  if (node.kind !== "human-approval")
    fail(
      "unsupported_node_kind",
      `node ${node.id} of kind ${node.kind} is not a human-approval node`,
    );
  validateIdentities(descriptor, node, input.identities);
  const fingerprint = computeFingerprint(
    "human_approval",
    descriptor.descriptor_hash,
    {
      activation_id: input.activation_id,
      transition_id: input.transition_id,
      decision,
      identities: input.identities,
    },
  );
  const existing = replayFence(projection, input.transition_id, fingerprint);
  if (existing !== undefined)
    return { projection, transition: existing, replayed: true };
  guardTransitionId(projection, input.transition_id);
  if (activation.status !== "ready")
    fail(
      "activation_not_ready",
      `activation ${input.activation_id} is not ready`,
    );
  if (decision.evidence_refs.length === 0)
    fail(
      "terminal_evidence_required",
      `approval decision for node ${node.id} requires at least one evidence reference`,
    );
  const outgoing = outgoingEdgesOf(descriptor, node.id);
  const fixedEdge =
    outgoing.length === 1 && outgoing[0].kind === "fixed"
      ? outgoing[0]
      : undefined;
  if (fixedEdge === undefined)
    fail(
      "invalid_input",
      `human-approval node ${node.id} must have exactly one fixed outgoing edge`,
    );
  const next = cloneProjection(projection);
  const { reserve } = reservation(next, input.transition_id);
  if (decision.decision === "denied") {
    next.activations[input.activation_id] = { ...activation, status: "failed" };
    const transition: GraphDeniedTransition = {
      ...transitionCommon(input, node, fingerprint, descriptor),
      outcome: "denied",
      selected_edge_ids: [],
      created_activation_ids: [],
      evidence_refs: nonEmptyEvidence(decision.evidence_refs),
      ...(decision.output_summary !== undefined && {
        output_summary: decision.output_summary,
      }),
    };
    next.committed_transitions[input.transition_id] = transition;
    return { projection: next, transition, replayed: false };
  }
  const nextActivationId = requireNextActivationId(input.identities, fixedEdge);
  reserve(nextActivationId, "activation id");
  next.activations[input.activation_id] = {
    ...activation,
    status: "completed",
    completed_transition_id: input.transition_id,
  };
  createNextActivation(
    next,
    nextActivationId,
    fixedEdge.to,
    activation,
    descriptor,
  );
  const transition: GraphApprovedTransition = {
    ...transitionCommon(input, node, fingerprint, descriptor),
    outcome: "approved",
    selected_edge_ids: [fixedEdge.id],
    created_activation_ids: [nextActivationId],
    evidence_refs: nonEmptyEvidence(decision.evidence_refs),
    ...(decision.output_summary !== undefined && {
      output_summary: decision.output_summary,
    }),
  };
  next.committed_transitions[input.transition_id] = transition;
  return { projection: next, transition, replayed: false };
}

/** Resolve a join: consume cohort + tokens exactly once, create the next activation. */
export function resolveJoin(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  input: ResolveJoinInput,
): SchedulerApplyResult {
  fenceDescriptor(descriptor, projection);
  requireStableId(input.activation_id, "activation id");
  const activation = requireActivation(projection, input.activation_id);
  const node = requireNode(descriptor, activation.node_id);
  if (node.kind !== "join")
    fail("join_not_found", `node ${node.id} is not a join node`);
  validateIdentities(descriptor, node, input.identities);
  const fingerprint = computeFingerprint(
    "resolve_join",
    descriptor.descriptor_hash,
    {
      activation_id: input.activation_id,
      transition_id: input.transition_id,
      identities: input.identities,
    },
  );
  const existing = replayFence(projection, input.transition_id, fingerprint);
  if (existing !== undefined)
    return { projection, transition: existing, replayed: true };
  guardTransitionId(projection, input.transition_id);
  const cohortId = activation.cohort_id;
  if (cohortId === undefined)
    fail(
      "join_not_ready",
      `join activation ${input.activation_id} has no cohort`,
    );
  const cohort = own(projection.cohorts, cohortId);
  if (cohort === undefined)
    fail("join_owner_missing", `cohort ${cohortId} not found`);
  if (cohort.owner_join_id !== node.id)
    fail(
      "join_owner_mismatch",
      `cohort ${cohortId} is owned by join ${cohort.owner_join_id}`,
    );
  if (cohort.consumed)
    fail("join_already_consumed", `cohort ${cohortId} was already consumed`);
  if (activation.status !== "ready")
    fail(
      "join_not_ready",
      `join activation ${input.activation_id} is not ready`,
    );
  const tokens = cohort.expected_branch_token_ids.map((tokenId) =>
    own(projection.branch_tokens, tokenId),
  );
  if (tokens.some((token) => token === undefined || token.status !== "arrived"))
    fail(
      "join_not_ready",
      `join ${node.id} does not have all branch tokens arrived`,
    );
  const outgoing = outgoingEdgesOf(descriptor, node.id);
  if (outgoing.length !== 1 || outgoing[0].kind !== "fixed")
    fail(
      "invalid_join_edge",
      `join ${node.id} must have exactly one fixed outgoing edge`,
    );
  const next = cloneProjection(projection);
  const { reserve } = reservation(next, input.transition_id);
  const nextActivationId = requireNextActivationId(
    input.identities,
    outgoing[0],
  );
  reserve(nextActivationId, "activation id");
  for (const tokenId of cohort.expected_branch_token_ids) {
    const token = own(next.branch_tokens, tokenId);
    if (token !== undefined)
      next.branch_tokens[tokenId] = {
        ...token,
        status: "consumed",
        current_activation_id: undefined,
        consumed_by_activation_id: activation.activation_id,
      };
  }
  next.cohorts[cohortId] = { ...cohort, consumed: true };
  next.activations[input.activation_id] = {
    ...activation,
    status: "completed",
    completed_transition_id: input.transition_id,
  };
  createNextActivation(
    next,
    nextActivationId,
    outgoing[0].to,
    activation,
    descriptor,
  );
  const transition: GraphJoinResolvedTransition = {
    ...transitionCommon(input, node, fingerprint, descriptor),
    outcome: "join_resolved",
    selected_edge_ids: [outgoing[0].id],
    created_activation_ids: [nextActivationId],
    evidence_refs: [],
    cohort_id: cohortId,
  };
  next.committed_transitions[input.transition_id] = transition;
  return { projection: next, transition, replayed: false };
}

/** Per-lineage traversal counter key (pure helper; no descriptor). */
export function traversalCounterKey(
  activation: GraphActivation,
  edge: GraphEdge,
): string {
  requireStableId(activation.traversal_owner_id, "traversal owner id");
  requireStableId(edge.id, "edge id");
  return canonicalJson([activation.traversal_owner_id, edge.id]);
}

/** Hash-fenced read: ready agent/command activations in code-unit order. */
export function listReadyExecutableActivations(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
): readonly GraphActivation[] {
  fenceDescriptor(descriptor, projection);
  return readyActivations(
    descriptor,
    projection,
    (node) => node.kind === "agent" || node.kind === "command",
  );
}

/** Hash-fenced read: ready human-approval activations in code-unit order. */
export function listReadyApprovalActivations(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
): readonly GraphActivation[] {
  fenceDescriptor(descriptor, projection);
  return readyActivations(
    descriptor,
    projection,
    (node) => node.kind === "human-approval",
  );
}

/** Hash-fenced read: ready join activations in code-unit order. */
export function listReadyJoinActivations(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
): readonly GraphActivation[] {
  fenceDescriptor(descriptor, projection);
  return readyActivations(
    descriptor,
    projection,
    (node) => node.kind === "join",
  );
}

function readyActivations(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  predicate: (node: GraphNode) => boolean,
): GraphActivation[] {
  const result: GraphActivation[] = [];
  for (const activation of Object.values(projection.activations)) {
    if (activation.status !== "ready") continue;
    const node = nodeById(descriptor, activation.node_id);
    if (node !== undefined && predicate(node)) result.push(activation);
  }
  return result.sort((a, b) => compareIds(a.activation_id, b.activation_id));
}

/**
 * Hash-fenced read: true iff at least one terminal verification activation
 * completed with a succeeded, evidence-bearing transition, every activation is
 * completed, and every cohort is consumed.
 */
export function isGraphSucceeded(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
): boolean {
  fenceDescriptor(descriptor, projection);
  const terminalVerified = projection.terminal_verification_activation_ids.some(
    (id) => {
      const activation = own(projection.activations, id);
      if (activation === undefined || activation.status !== "completed")
        return false;
      const transition = activation.completed_transition_id
        ? own(
            projection.committed_transitions,
            activation.completed_transition_id,
          )
        : undefined;
      return (
        transition?.outcome === "succeeded" &&
        transition.evidence_refs.length > 0
      );
    },
  );
  if (!terminalVerified) return false;
  const allCompleted = Object.values(projection.activations).every(
    (activation) => activation.status === "completed",
  );
  if (!allCompleted) return false;
  return Object.values(projection.cohorts).every((cohort) => cohort.consumed);
}
