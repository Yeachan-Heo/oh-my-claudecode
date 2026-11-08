/**
 * Runtime runner: the orchestration loop binding the pure Graph Core
 * scheduler to disk-backed journal/fence/projection-store and injected
 * executors.
 *
 * Replay contract (AC-3/AC-11b): the journal is the source of truth; on
 * resume, records are folded through the same scheduler entrypoints used
 * live. Synthetic identities are regenerated deterministically from
 * projection counters and the committed record fields, so the folded
 * projection equals the live one bit-for-bit under canonicalJson equality,
 * including embedded request fingerprints.
 */

import { join } from "path";

import {
  GraphDescriptorValidationError,
  canonicalJson,
  parseSealedGraphDescriptor,
} from "../descriptor.js";
import {
  GraphSchedulerError,
  applyHumanApproval,
  applyNodeResult,
  beginActivationAttempt,
  initializeGraphProjection,
  isGraphSucceeded,
  listReadyApprovalActivations,
  listReadyExecutableActivations,
  listReadyJoinActivations,
  resolveJoin,
} from "../scheduler.js";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
import { resolveRunDirHandle } from "./run-dir.js";
import type { RunDirHandle } from "./run-dir.js";
import { computeJournalFingerprint, FileJournal } from "./journal.js";
import { FileOwnershipFence } from "./fence.js";
import { FileProjectionStore } from "./store.js";
import {
  assertContainedFsSupported,
  readContainedFileNoFollow,
  withContainedOperations,
} from "./safe-fs.js";

import { EXIT_CODES, FenceError, JournalCorruptionError } from "./types.js";
import type {
  ApprovalRequest,
  JournalRecord,
  NodeExecutionContext,
  NodeExecutionOutput,
  NodeExecutor,
  RunOptions,
  RunResult,
  RuntimeProgressEvent,
} from "./types.js";
import type {
  GraphCommittedTransition,
  GraphEdge,
  GraphNodeResult,
  GraphSchedulerProjection,
  SchedulerTransitionIdentities,
  SealedGraphDescriptor,
} from "../types.js";

const DEFAULT_RUNS_ROOT_SEGMENTS = [".omc", "graph-runs"];
const DESCRIPTOR_FILE_NAME = "descriptor.json";
const REQUEST_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Deterministic synthetic identity scheme
//
// Every runner-generated id follows one scheme so that live generation and
// replay derivation reconstruct identical values:
//
//   activation   `<nodeId>-act<n>`        n = count of activations of that node
//   attempt      `<activationId>-t<n>`    n = post-begin attempt number
//   transition   `<activationId>-tx<n>`   n = attempt number (0 for approval/join)
//   cohort       `<fanoutNodeId>-coh<k>`  k = count of cohorts of that node
//   token        `<cohortId>-tok<i>`      i = index within fan-out edge order
//
// The team brief sketched "<node_id>#{ordinal}", but "#" sits outside the
// stable-id charset ([A-Za-z0-9][A-Za-z0-9._:-]*), so "-" separators keep
// every generated id valid per the scheduler's isValidStableId gate.
// ---------------------------------------------------------------------------

function outgoingEdgesOf(
  descriptor: SealedGraphDescriptor,
  nodeId: string,
): GraphEdge[] {
  return descriptor.edges.filter((edge) => edge.from === nodeId);
}

function sealedNode(
  descriptor: SealedGraphDescriptor,
  nodeId: string,
) {
  return descriptor.nodes.find((node) => node.id === nodeId);
}

function activationCount(
  projection: GraphSchedulerProjection,
  nodeId: string,
): number {
  return Object.values(projection.activations).filter(
    (activation) => activation.node_id === nodeId,
  ).length;
}

function cohortCount(
  projection: GraphSchedulerProjection,
  fanoutNodeId: string,
): number {
  return Object.values(projection.cohorts).filter(
    (cohort) => cohort.fan_out_node_id === fanoutNodeId,
  ).length;
}

/** Entry activations are the ordinal-0 activation of each entry node. */
function entryActivationIds(
  descriptor: SealedGraphDescriptor,
): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const entry of descriptor.entry_node_ids) {
    ids[entry] = `${entry}-act0`;
  }
  return ids;
}

function nextAttemptId(activationId: string, attemptNo: number): string {
  return `${activationId}-t${attemptNo}`;
}

/**
 * Transition id per activation attempt. Keying by activation (not by node)
 * keeps two concurrent activations of the same node from racing on a shared
 * counter; attempt numbers are unique within an activation, so ids are fresh.
 */
function transitionIdFor(activationId: string, ordinal: number): string {
  return `${activationId}-tx${ordinal}`;
}

function nextCohortId(
  projection: GraphSchedulerProjection,
  fanoutNodeId: string,
): string {
  return `${fanoutNodeId}-coh${cohortCount(projection, fanoutNodeId)}`;
}

function tokenIdFor(cohortId: string, index: number): string {
  return `${cohortId}-tok${index}`;
}

function nextActivationIdFor(
  projection: GraphSchedulerProjection,
  targetNodeId: string,
): string {
  return `${targetNodeId}-act${activationCount(projection, targetNodeId)}`;
}

// ---------------------------------------------------------------------------
// Identity construction: one builder per call-site shape
// ---------------------------------------------------------------------------

/**
 * Live node-result identities. Mirrors the scheduler's edge-mode selection
 * exactly so the generated maps contain precisely the fields applyNodeResult
 * will demand for this outcome.
 */
function buildLiveNodeResultIdentities(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  nodeId: string,
  activationId: string,
  output: NodeExecutionOutput,
): SchedulerTransitionIdentities | undefined {
  if (output.outcome === "failed") {
    return undefined;
  }
  const edges = outgoingEdgesOf(descriptor, nodeId);
  if (edges.length === 0) {
    return undefined;
  }
  const fanEdges = edges.filter((edge) => edge.kind === "fan_out");
  if (fanEdges.length > 0) {
    const cohortId = nextCohortId(projection, nodeId);
    const branchTokenIds: Record<string, string> = {};
    const nextActivationIds: Record<string, string> = {};
    fanEdges.forEach((edge, index) => {
      branchTokenIds[edge.id] = tokenIdFor(cohortId, index);
      nextActivationIds[edge.id] = nextActivationIdFor(projection, edge.to);
    });
    return {
      cohort_id: cohortId,
      branch_token_ids: branchTokenIds,
      next_activation_ids: nextActivationIds,
    };
  }
  const fixedEdge = edges.find((edge) => edge.kind === "fixed");
  let matchedEdge: GraphEdge | undefined = fixedEdge;
  if (matchedEdge === undefined) {
    if (output.route === undefined) {
      // The scheduler will reject this result with `route_required`; hand it
      // identity-free to the scheduler rather than inventing a route.
      return undefined;
    }
    matchedEdge = edges.find(
      (edge) =>
        (edge.kind === "conditional" || edge.kind === "back_edge") &&
        edge.route === output.route,
    );
    if (matchedEdge === undefined) {
      // Undeclared route: scheduler rejects with `undeclared_route`.
      return undefined;
    }
  }
  // Join-target edges: the scheduler demands join_activation_id exactly when
  // this completion is the last arriving branch token of the cohort.
  const targetNode = sealedNode(descriptor, matchedEdge.to);
  if (targetNode?.kind === "join") {
    return joinArrivalIdentities(descriptor, projection, activationId, targetNode);
  }
  return {
    next_activation_ids: {
      [matchedEdge.id]: nextActivationIdFor(projection, matchedEdge.to),
    },
  };
}

/**
 * Identities for a branch completion whose edge targets the cohort's join.
 * Supplies join_activation_id iff every sibling token has already arrived;
 * the scheduler creates nothing otherwise.
 */
function joinArrivalIdentities(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  activationId: string,
  joinNode: { readonly id: string },
): SchedulerTransitionIdentities | undefined {
  const sourceActivation = Object.values(projection.activations).find(
    (activation) =>
      activation.activation_id === activationId &&
      activation.status === "running" &&
      activation.branch_token_id !== undefined,
  );
  const token =
    sourceActivation?.branch_token_id !== undefined
      ? projection.branch_tokens[sourceActivation.branch_token_id]
      : undefined;
  if (
    token === undefined ||
    token.status !== "active" ||
    token.current_activation_id !== sourceActivation?.activation_id
  ) {
    throw new Error(
      `activation ${activationId} does not hold an active branch token`,
    );
  }
  const cohort = projection.cohorts[token.cohort_id];
  if (cohort === undefined) {
    throw new Error(`cohort ${token.cohort_id} missing from projection`);
  }
  const siblingsArrived = cohort.expected_branch_token_ids.every(
    (tokenIdValue) =>
      tokenIdValue === token.branch_token_id ||
      projection.branch_tokens[tokenIdValue]?.status === "arrived",
  );
  return siblingsArrived
    ? {
        join_activation_id: nextActivationIdFor(projection, joinNode.id),
      }
    : undefined;
}

/**
 * Replay identities derived from fields ON THE RECORD. Fan-out token ids are
 * regenerated from the recorded cohort id plus the record's selected-edge
 * order; activation ids come straight from created_activation_ids. A single
 * created activation on an edge targeting a join node means the join fired:
 * the record carries it as join_activation_id, not next_activation_ids.
 */
function buildReplayNodeResultIdentities(
  descriptor: SealedGraphDescriptor,
  transition: GraphCommittedTransition,
): SchedulerTransitionIdentities | undefined {
  if (transition.outcome === "failed") {
    return undefined;
  }
  if (transition.selected_edge_ids.length === 0) {
    return undefined;
  }
  if (
    transition.outcome === "succeeded" &&
    outgoingEdgesOf(descriptor, transition.node_id).some(
      (edge) => edge.kind === "fan_out",
    )
  ) {
    const fanEdges = outgoingEdgesOf(descriptor, transition.node_id).filter(
      (edge) => edge.kind === "fan_out",
    );
    const cohortId = transition.cohort_id;
    if (cohortId === undefined) {
      return undefined; // scheduler rejects with missing_identity during fold
    }
    return {
      cohort_id: cohortId,
      branch_token_ids: Object.fromEntries(
        fanEdges.map((edge, index) => [edge.id, tokenIdFor(cohortId, index)]),
      ),
      next_activation_ids: Object.fromEntries(
        transition.selected_edge_ids.map((edgeId, index) => [
          edgeId,
          transition.created_activation_ids[index] as string,
        ]),
      ),
    };
  }
  // Single-edge success: a created activation on an edge targeting a join
  // node means the join fired on this completion (last token arrived).
  // Non-final arrivals create nothing (created_activation_ids is empty) and
  // live passes no identities, so replay must return undefined too — else
  // the folded request_fingerprint diverges from the committed one.
  const selEdgeId = transition.selected_edge_ids[0] as string;
  const matchedEdge = outgoingEdgesOf(descriptor, transition.node_id).find(
    (edge) => edge.id === selEdgeId,
  );
  const targetNode =
    matchedEdge === undefined
      ? undefined
      : descriptor.nodes.find((node) => node.id === matchedEdge.to);
  if (targetNode?.kind === "join") {
    if (transition.created_activation_ids.length === 0) {
      return undefined;
    }
    return {
      join_activation_id: transition.created_activation_ids[0] as string,
    };
  }
  return {
    next_activation_ids: Object.fromEntries(
      transition.selected_edge_ids.map((edgeId, index) => [
        edgeId,
        transition.created_activation_ids[index] as string,
      ]),
    ),
  };
}

/**
 * Replay identities for human-approval transitions: approved carries the
 * single created activation; denied carries none.
 */
function buildReplayApprovalIdentities(
  transition: GraphCommittedTransition,
): SchedulerTransitionIdentities | undefined {
  if (transition.outcome === "approved") {
    const edgeId = transition.selected_edge_ids[0] as string;
    const createdId = transition.created_activation_ids[0] as string;
    return {
      next_activation_ids: { [edgeId]: createdId },
    };
  }
  return undefined;
}

/** Replay identities for join_resolved transitions. */
function buildReplayJoinIdentities(
  transition: GraphCommittedTransition,
): SchedulerTransitionIdentities {
  const edgeId = transition.selected_edge_ids[0] as string;
  return {
    next_activation_ids: {
      [edgeId]: transition.created_activation_ids[0] as string,
    },
  };
}

/** Folds one journal record through its scheduler transition entrypoint. */
function foldOneRecord(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  record: JournalRecord,
): GraphSchedulerProjection {
  const transition = record.transition;
  // The scheduler recomputes the request fingerprint from the replay request,
  // but it deliberately does not consume persisted transition metadata. Keep
  // those fields explicit at the runtime boundary so a forged envelope cannot
  // smuggle a foreign descriptor or fingerprint version through a valid fold.
  if (
    transition.descriptor_hash !== descriptor.descriptor_hash
  ) {
    throw new GraphSchedulerError(
      "descriptor_mismatch",
      `journal record ${record.seq} transition is bound to descriptor ${transition.descriptor_hash}`,
    );
  }
  if (transition.fingerprint_version !== 1) {
    throw new GraphSchedulerError(
      "transition_fenced",
      `journal record ${record.seq} has unsupported fingerprint_version ${String(transition.fingerprint_version)}`,
    );
  }
  if (
    typeof transition.request_fingerprint !== "string" ||
    !REQUEST_FINGERPRINT_PATTERN.test(transition.request_fingerprint)
  ) {
    throw new GraphSchedulerError(
      "transition_fenced",
      `journal record ${record.seq} has invalid request_fingerprint metadata`,
    );
  }
  const { journal_fingerprint: recordedFingerprint, ...unsignedRecord } =
    record;
  if (recordedFingerprint !== computeJournalFingerprint(unsignedRecord)) {
    throw new GraphSchedulerError(
      "transition_fenced",
      `journal record ${record.seq} fails its envelope fingerprint`,
    );
  }
  let applied;
  switch (transition.outcome) {
    case "succeeded":
    case "failed":
      applied = foldNodeResultRecord(descriptor, projection, transition);
      break;
    case "approved":
    case "denied":
      applied = applyHumanApproval(descriptor, projection, {
        activation_id: transition.activation_id,
        transition_id: transition.transition_id,
        decision: {
          decision: transition.outcome === "approved" ? "approved" : "denied",
          evidence_refs: transition.evidence_refs,
          ...(transition.output_summary !== undefined && {
            output_summary: transition.output_summary,
          }),
        },
        identities: buildReplayApprovalIdentities(transition),
      });
      break;
    case "join_resolved":
      applied = resolveJoin(descriptor, projection, {
        activation_id: transition.activation_id,
        transition_id: transition.transition_id,
        identities: buildReplayJoinIdentities(transition),
      });
      break;
    default:
      throw new GraphSchedulerError(
        "transition_fenced",
        `journal record ${record.seq} has an unknown transition outcome`,
      );
  }
  // AC-11b content-tamper detection: a record whose fields were edited
  // after commit folds into a DIFFERENT recomputed request fingerprint.
  if (
    applied.transition.request_fingerprint !==
    record.transition.request_fingerprint
  ) {
    throw new GraphSchedulerError(
      "transition_fenced",
      `journal record ${record.seq} fails its committed request fingerprint`,
    );
  }
  return applied.projection;
}

function foldNodeResultRecord(
  descriptor: SealedGraphDescriptor,
  projection: GraphSchedulerProjection,
  transition:
    | Extract<GraphCommittedTransition, { outcome: "succeeded" }>
    | Extract<GraphCommittedTransition, { outcome: "failed" }>,
) {
  // Synthesize the attempt begin (commits no record) so the folded
  // activation is running the recorded attempt when applyNodeResult runs.
  const withAttempt = beginActivationAttempt(descriptor, projection, {
    activation_id: transition.activation_id,
    attempt_id: transition.attempt_id,
  });
  const replayedResult: GraphNodeResult = {
    outcome: transition.outcome,
    attempt_id: transition.attempt_id,
    ...(transition.outcome === "succeeded" &&
      transition.route !== undefined && { route: transition.route }),
    ...(transition.output_summary !== undefined && {
      output_summary: transition.output_summary,
    }),
    evidence_refs: transition.evidence_refs,
    ...(transition.external_idempotency_key !== undefined && {
      external_idempotency_key: transition.external_idempotency_key,
    }),
  };
  return applyNodeResult(descriptor, withAttempt, {
    activation_id: transition.activation_id,
    transition_id: transition.transition_id,
    result: replayedResult,
    identities: buildReplayNodeResultIdentities(descriptor, transition),
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Inflight executor dispatch tracked by the loop. The settlement wrapper
 * never rejects, so awaiting the underlying promises cannot throw.
 */
interface InflightExecution {
  readonly activationId: string;
  readonly nodeId: string;
  readonly attemptNo: number;
  readonly attemptId: string;
  readonly transitionId: string;
  readonly promise: Promise<void>;
  settled?: NodeExecutionOutput | "threw";
}

/**
 * Runs one sealed graph to a terminal outcome.
 *
 * Exit mapping (normative, EXIT_CODES): FenceError busy/fenced_out -> 19,
 * JournalCorruptionError -> 20, descriptor mismatch -> 21, graph-terminal
 * failure -> 1, success -> 0. Mapped failures keep the lock file (abnormal
 * exit); only normal termination releases it — stale reap covers crashes.
 */
export async function runGraph(
  sealed: SealedGraphDescriptor,
  options: RunOptions,
): Promise<RunResult> {
  // Refuse unsupported POSIX platforms before resolving/acquiring any
  // run-scoped ownership state. Node has no supported openat/f*at API, so a
  // pathname fallback would make the containment guarantee raceable.
  assertContainedFsSupported(process.platform);
  const runsRoot =
    options.runsRoot ?? join(process.cwd(), ...DEFAULT_RUNS_ROOT_SEGMENTS);
  const runId = sealed.run_id;
  // Contained run dir (P1-3): validates run_id, rejects symlink escapes, and
  // creates the directory before any persistence component touches disk.
  const runDirHandle: RunDirHandle = resolveRunDirHandle(runsRoot, runId);
  const fence = new FileOwnershipFence(runsRoot, runId, undefined, runDirHandle);
  const store = new FileProjectionStore(runsRoot, runId, runDirHandle);

  const emit = (event: RuntimeProgressEvent): void => {
    options.reporter?.onEvent(event);
  };
  const acquired = await fence.acquire();
  if (acquired.outcome === "busy") {
    // Emit a terminal event so progress consumers never dangle on a busy
    // refusal; there is no run_started to pair it with in this path.
    emit({
      type: "run_ended",
      terminal: "failed",
      summary: "another writer owns this run",
    });
    return {
      terminal: "failed",
      epoch: 0,
      exit_code: EXIT_CODES.FENCED_OUT,
      run_id: runId,
      descriptor_hash: sealed.descriptor_hash,
    };
  }
  const epoch = acquired.epoch;
  // Bind journal publication to this acquired ownership epoch.  The journal
  // performs the final check while its append fd is open and rolls back a
  // suffix when that check observes lease loss.
  const journal = new FileJournal(
    runsRoot,
    runId,
    runDirHandle,
    () => fence.assertEpoch(epoch),
  );

  // Phase gates which GraphSchedulerError maps to CORRUPT_JOURNAL(20):
  // startup/fold-phase scheduler errors mean tampered persisted state;
  // live-phase ones are runner/executor contract violations and rethrow.
  let phase: "startup" | "fold" | "live" = "startup";

  try {
    emit({ type: "run_started", run_id: runId, goal: sealed.goal });
    let stored: SealedGraphDescriptor;
    let rawDescriptor: string | null;
    try {
      rawDescriptor = readContainedFileNoFollow(
        runDirHandle,
        DESCRIPTOR_FILE_NAME,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rawDescriptor = null;
      } else {
        throw error;
      }
    }
    let descriptorIsFresh = false;
    if (rawDescriptor === null) {
      withContainedOperations(runDirHandle, (operations) => {
        atomicWriteFileSync(DESCRIPTOR_FILE_NAME, canonicalJson(sealed), undefined, operations);
      });
      stored = sealed;
      descriptorIsFresh = true;
    } else {
      stored = parseSealedGraphDescriptor(JSON.parse(rawDescriptor));
      if (canonicalJson(stored) !== canonicalJson(sealed)) {
        throw new GraphSchedulerError(
          "descriptor_mismatch",
          `persisted descriptor for run ${runId} does not match the supplied one`,
        );
      }
    }

    // Replay fold: always a full fold; the snapshot is a status cache only.
    phase = "fold";
    // A persisted descriptor establishes a run identity.  It is not valid to
    // resume that identity from an absent/empty journal: doing so would let a
    // caller replay the entry activations as if no history existed.  Fresh
    // descriptors are the sole exception; their journal is created by the
    // first committed transition below.
    const records = await journal.readAll();
    if (!descriptorIsFresh && records.length === 0) {
      throw new GraphSchedulerError(
        "transition_fenced",
        `persisted descriptor for run ${runId} has no committed journal history`,
      );
    }
    let projection = initializeGraphProjection(
      stored,
      entryActivationIds(stored),
    );
    if (descriptorIsFresh) {
      await store.save({
        schema_version: 1,
        descriptor_hash: stored.descriptor_hash,
        run_id: stored.run_id,
        revision_id: stored.revision_id,
        epoch,
        saved_at_seq: -1,
        projection,
      }, () => fence.assertEpoch(epoch));
    }
    // Epoch provenance: takeovers only ever raise the epoch, so committed
    // history must be non-decreasing and must never exceed the epoch this
    // process acquired — anything else is forged or stale-writer provenance.
    let lastRecordEpoch = 0;
    for (const record of records) {
      if (record.descriptor_hash !== stored.descriptor_hash) {
        throw new GraphSchedulerError(
          "descriptor_mismatch",
          `journal record ${record.seq} is bound to descriptor ${record.descriptor_hash}`,
        );
      }
      if (record.epoch < lastRecordEpoch || record.epoch > epoch) {
        throw new GraphSchedulerError(
          "transition_fenced",
          `journal record ${record.seq} carries epoch ${record.epoch} outside fenced history (last ${lastRecordEpoch}, acquired ${epoch})`,
        );
      }
      if (record.transition.descriptor_hash !== record.descriptor_hash) {
        throw new GraphSchedulerError(
          "descriptor_mismatch",
          `journal record ${record.seq} transition descriptor does not match its envelope`,
        );
      }
      lastRecordEpoch = record.epoch;
      projection = foldOneRecord(stored, projection, record);
    }
    emit({ type: "replayed", records: records.length, epoch });

    // --- main loop ---
    phase = "live";
    let nextSeq = records.length;
    const inflight: InflightExecution[] = [];
    /** Attempt budget is exhausted; scheduler keeps these terminal-failed. */
    const deadActivations = new Set<string>();
    const concurrencyLimit = sealed.concurrency_limit;
    let terminalResult: RunResult | null = null;
    let terminalSummary: string = "";

    /**
     * Persists one committed transition: journal append then snapshot save,
     * both awaited before the caller proceeds (durability ordering).
     */
    const persistTransition = async (
      transition: GraphCommittedTransition,
    ): Promise<void> => {
      const seq = nextSeq;
      nextSeq += 1;
      // Do not publish a transition after ownership has been lost while an
      // executor or approval prompt was in flight.
      fence.assertEpoch(epoch);
      await journal.append({
        seq,
        epoch,
        descriptor_hash: stored.descriptor_hash,
        transition,
      });
      fence.assertEpoch(epoch);
      await store.save({
        schema_version: 1,
        descriptor_hash: stored.descriptor_hash,
        run_id: stored.run_id,
        revision_id: stored.revision_id,
        epoch,
        saved_at_seq: seq,
        projection,
      }, () => fence.assertEpoch(epoch));
    };

    /** Finds the executor registered for an executable node kind. */
    const findExecutor = (nodeId: string): NodeExecutor => {
      const node = sealed.nodes.find((candidate) => candidate.id === nodeId);
      const executor =
        node === undefined
          ? undefined
          : options.executors.find((candidate) =>
              candidate.kinds.includes(
                node.kind as Parameters<NodeExecutor["execute"]>[0]["node"]["kind"],
              ),
            );
      if (executor === undefined) {
        throw new Error(`no executor registered for node kind of ${nodeId}`);
      }
      return executor;
    };

    /**
     * Begins the next attempt for the first schedulable executable
     * activation and dispatches it without awaiting. Returns true when a
     * new execution was started.
     */
    const dispatchNextExecutable = (): boolean => {
      const ready = listReadyExecutableActivations(sealed, projection);
      const candidate = ready.find(
        (activation) =>
          !inflight.some(
            (entry) => entry.activationId === activation.activation_id,
          ) && !deadActivations.has(activation.activation_id),
      );
      if (candidate === undefined) {
        return false;
      }
      const node = sealed.nodes.find((n) => n.id === candidate.node_id);
      if (
        node === undefined ||
        (node.kind !== "agent" && node.kind !== "command")
      ) {
        throw new Error(
          `ready activation ${candidate.activation_id} is not executable`,
        );
      }
      const attemptNo = candidate.attempt_no + 1;
      const attemptId = nextAttemptId(candidate.activation_id, attemptNo);
      let running: GraphSchedulerProjection;
      try {
        running = beginActivationAttempt(sealed, projection, {
          activation_id: candidate.activation_id,
          attempt_id: attemptId,
        });
      } catch (error) {
        if (
          error instanceof GraphSchedulerError &&
          error.code === "max_attempts_exceeded"
        ) {
          deadActivations.add(candidate.activation_id);
          return false; // leave terminal-failed per scheduler contract (AC-9)
        }
        throw error;
      }
      projection = running;
      const context: NodeExecutionContext = {
        descriptor: sealed,
        node,
        activation_id: candidate.activation_id,
        attempt_id: attemptId,
        attempt_no: attemptNo,
      };
      const transitionId = transitionIdFor(candidate.activation_id, attemptNo);
      const executor = findExecutor(node.id);
      emit({
        type: "activation_started",
        node_id: node.id,
        attempt_no: attemptNo,
      });
      const entry: InflightExecution = {
        activationId: candidate.activation_id,
        nodeId: node.id,
        attemptNo,
        attemptId,
        transitionId,
        promise: Promise.resolve().then(() =>
          executor.execute(context).then(
            (output) => {
              entry.settled = output;
            },
            (_error: unknown) => {
              entry.settled = "threw";
            },
          ),
        ),
      };
      inflight.push(entry);
      return true;
    };

    /**
     * Commits every settled execution in FIFO order, applying node results
     * through the scheduler and persisting each committed transition.
     */
    const drainSettled = async (): Promise<void> => {
      for (let index = 0; index < inflight.length; ) {
        const entry = inflight[index];
        if (entry.settled === undefined) {
          index += 1;
          continue;
        }
        inflight.splice(index, 1);
        const output =
          entry.settled === "threw"
            ? ({
                outcome: "failed",
                output_summary: "executor threw during execution",
                evidence_refs: [],
              } satisfies NodeExecutionOutput)
            : entry.settled;
        entry.settled = undefined;
        const result: GraphNodeResult = {
          outcome: output.outcome,
          attempt_id: entry.attemptId,
          ...(output.route !== undefined && { route: output.route }),
          ...(output.output_summary !== undefined && {
            output_summary: output.output_summary,
          }),
          evidence_refs: output.evidence_refs,
          ...(output.external_idempotency_key !== undefined && {
            external_idempotency_key: output.external_idempotency_key,
          }),
        };
        const identities = buildLiveNodeResultIdentities(
          sealed,
          projection,
          entry.nodeId,
          entry.activationId,
          output,
        );
        const applied = applyNodeResult(sealed, projection, {
          activation_id: entry.activationId,
          transition_id: entry.transitionId,
          result,
          identities,
        });
        projection = applied.projection;
        emit({
          type: "node_result",
          node_id: entry.nodeId,
          outcome: applied.transition.outcome,
        });
        await persistTransition(applied.transition);
      }
    };

    /** Prompts and commits one human-approval activation (FIFO order). */
    const commitApproval = async (): Promise<void> => {
      const activation = listReadyApprovalActivations(sealed, projection)[0];
      if (activation === undefined) {
        return;
      }
      const node = sealed.nodes.find((n) => n.id === activation.node_id);
      if (node === undefined || node.kind !== "human-approval") {
        throw new Error(
          `ready approval activation ${activation.activation_id} is not a human-approval node`,
        );
      }
      const request: ApprovalRequest = {
        run_id: runId,
        node_id: node.id,
        activation_id: activation.activation_id,
        prompt_text: node.prompt,
      };
      const decision = await options.prompter.prompt(request);
      const decisionRecord = {
        decision,
        evidence_refs: [
          {
            kind: "human" as const,
            ref: `approval:${runId}:${node.id}`,
            summary: `human decision for ${node.id}`,
          },
        ],
      };
      const fixedEdge = outgoingEdgesOf(sealed, node.id).find(
        (edge) => edge.kind === "fixed",
      );
      if (decision === "approved") {
        if (fixedEdge === undefined) {
          throw new Error(
            `human-approval node ${node.id} has no fixed outgoing edge`,
          );
        }
        const identities = {
          next_activation_ids: {
            [fixedEdge.id]: nextActivationIdFor(projection, fixedEdge.to),
          },
        };
        const applied = applyHumanApproval(sealed, projection, {
          activation_id: activation.activation_id,
          transition_id: transitionIdFor(activation.activation_id, 0),
          decision: decisionRecord,
          identities,
        });
        projection = applied.projection;
        emit({
          type: "node_result",
          node_id: node.id,
          outcome: applied.transition.outcome,
        });
        await persistTransition(applied.transition);
        return;
      }
      const denied = applyHumanApproval(sealed, projection, {
        activation_id: activation.activation_id,
        transition_id: transitionIdFor(activation.activation_id, 0),
        decision: decisionRecord,
      });
      projection = denied.projection;
      emit({
        type: "node_result",
        node_id: node.id,
        outcome: denied.transition.outcome,
      });
      await persistTransition(denied.transition);
    };

    /** Resolves one ready join activation. */
    const commitJoin = async (): Promise<void> => {
      const activation = listReadyJoinActivations(sealed, projection)[0];
      if (activation === undefined) {
        return;
      }
      const outgoing = outgoingEdgesOf(sealed, activation.node_id);
      const fixedEdge = outgoing.find((edge) => edge.kind === "fixed");
      if (fixedEdge === undefined) {
        throw new Error(
          `join node ${activation.node_id} has no fixed outgoing edge`,
        );
      }
      const applied = resolveJoin(sealed, projection, {
        activation_id: activation.activation_id,
        transition_id: transitionIdFor(activation.activation_id, 0),
        identities: {
          next_activation_ids: {
            [fixedEdge.id]: nextActivationIdFor(projection, fixedEdge.to),
          },
        },
      });
      projection = applied.projection;
      emit({
        type: "node_result",
        node_id: activation.node_id,
        outcome: applied.transition.outcome,
      });
      await persistTransition(applied.transition);
    };

    while (terminalResult === null) {
      fence.assertEpoch(epoch);
      if (options.signal?.aborted === true) {
        throw new Error("graph run aborted");
      }
      while (
        inflight.length < concurrencyLimit &&
        dispatchNextExecutable()
      ) {
        // Fill executor slots up to the concurrency limit.
      }
      const approvalActivation = listReadyApprovalActivations(
        sealed,
        projection,
      )[0];
      if (approvalActivation !== undefined) {
        await commitApproval();
        continue;
      }
      if (listReadyJoinActivations(sealed, projection).length > 0) {
        await commitJoin();
        continue;
      }

      // Wait for at least one inflight execution to settle, then drain all
      // settled entries (several may complete together).
      if (inflight.length > 0) {
        await Promise.race(inflight.map((entry) => entry.promise));
        await drainSettled();
        continue;
      }

      // Idle: evaluate terminal conditions.
      if (isGraphSucceeded(sealed, projection)) {
        terminalResult = {
          terminal: "succeeded",
          run_id: runId,
          descriptor_hash: stored.descriptor_hash,
          epoch,
          exit_code: EXIT_CODES.OK,
        };
        terminalSummary = `graph succeeded (${nextSeq} committed transitions)`;
        break;
      }
      const hasWork =
        listReadyExecutableActivations(sealed, projection).some(
          (activation) =>
            !inflight.some((entry) => entry.activationId === activation.activation_id) &&
            !deadActivations.has(activation.activation_id),
        ) ||
        listReadyApprovalActivations(sealed, projection).length > 0 ||
        listReadyJoinActivations(sealed, projection).length > 0;
      if (!hasWork) {
        terminalResult = {
          terminal: "failed",
          run_id: runId,
          descriptor_hash: stored.descriptor_hash,
          epoch,
          exit_code: EXIT_CODES.FAILED_TERMINAL,
        };
        terminalSummary = "no schedulable activations";
        break;
      }
      throw new Error("runner stalled with schedulable work remaining");
    }

    // Release before emitting run_ended: if release throws, the catch path
    // emits the single run_ended for this run instead of a duplicate.
    const released = await fence.release(epoch);
    if (!released) {
      terminalResult = {
        terminal: "failed",
        run_id: runId,
        descriptor_hash: stored.descriptor_hash,
        epoch,
        exit_code: EXIT_CODES.FENCED_OUT,
      };
      terminalSummary = "graph ownership lost before release";
    }
    emit({
      type: "run_ended",
      terminal: terminalResult.terminal,
      summary: terminalSummary,
    });
    return terminalResult;
  } catch (error) {
    const mapped = mapRunFailure(
      error,
      phase,
      epoch,
      runId,
      sealed.descriptor_hash,
    );
    if (mapped === null) {
      throw error;
    }
    emit({
      type: "run_ended",
      terminal: "failed",
      summary: mapped.message ?? "run failed",
    });
    return mapped.result;
  }
}

// ---------------------------------------------------------------------------
// Failure mapping (exit codes are normative)
// ---------------------------------------------------------------------------

/**
 * Maps persisted-state failures to their normative exit codes; returns null
 * for anything else (caller rethrows). Fence/corruption/descriptor failures
 * keep the lock file: abnormal exits rely on stale reap.
 */
function mapRunFailure(
  error: unknown,
  phase: "startup" | "fold" | "live",
  epoch: number,
  runId: string,
  descriptorHash: string,
): { readonly result: RunResult; readonly message: string } | null {
  const result = (
    exitCode: RunResult["exit_code"],
  ): { readonly result: RunResult; readonly message: string } => ({
    result: {
      terminal: "failed",
      epoch,
      exit_code: exitCode,
      run_id: runId,
      descriptor_hash: descriptorHash,
    },
    message: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof FenceError) {
    return result(EXIT_CODES.FENCED_OUT);
  }
  if (error instanceof JournalCorruptionError) {
    return result(EXIT_CODES.CORRUPT_JOURNAL);
  }
  if (error instanceof GraphDescriptorValidationError) {
    return result(EXIT_CODES.DESCRIPTOR_MISMATCH);
  }
  if (error instanceof GraphSchedulerError) {
    if (error.code === "descriptor_mismatch") {
      return result(EXIT_CODES.DESCRIPTOR_MISMATCH);
    }
    if (phase !== "live") {
      return result(EXIT_CODES.CORRUPT_JOURNAL);
    }
  }
  return null;
}
