/**
 * Contract-authored scheduler tests (S1-S26) for Graph Core.
 *
 * Authored from the ralplan stage-04 revision (`pending-approval.md`); oracle
 * `99ffe31` used only for behavioral cross-checks. S10/S20 implement the
 * stage-04 deltas (exact approval records, persisted-sealed scheduler flow
 * without type assertion); S21-S26 cover review-blocker adversarial cases.
 */
import { describe, expect, it } from "vitest";
import {
  parseSealedGraphDescriptor,
  sealGraphDescriptor,
  verifyDescriptorHash,
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
  releaseAttemptForRetry,
  resolveJoin,
  traversalCounterKey,
} from "../scheduler.js";
import type {
  ApplyHumanApprovalInput,
  ApplyNodeResultInput,
  GraphDescriptorInput,
  GraphSchedulerErrorCode,
  GraphSchedulerProjection,
  SchedulerTransitionIdentities,
  SealedGraphDescriptor,
} from "../types.js";
import {
  approvalDescriptor,
  executableNode,
  forkJoinDescriptor,
  loopDescriptor,
} from "./fixtures.js";

const EVIDENCE = [
  { kind: "command", ref: "npm run test:run -- src/graph" },
] as const;
const sealedOf = (input: GraphDescriptorInput): SealedGraphDescriptor =>
  sealGraphDescriptor(input);
const ok = (
  attemptId: string,
): { outcome: "succeeded"; attempt_id: string; evidence_refs: [] } => ({
  outcome: "succeeded",
  attempt_id: attemptId,
  evidence_refs: [],
});

function chainDescriptor(maxAttempts: number): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-sched-chain",
    revision_id: "rev-sched-chain",
    goal: "scheduler chain",
    nodes: [
      { ...executableNode("start", "agent"), max_attempts: maxAttempts },
      { ...executableNode("work", "command"), max_attempts: maxAttempts },
      { ...executableNode("term", "command"), max_attempts: 1 },
    ],
    edges: [
      { id: "e-start-work", kind: "fixed", from: "start", to: "work" },
      { id: "e-work-term", kind: "fixed", from: "work", to: "term" },
    ],
    entry_node_ids: ["start"],
    concurrency_limit: 1,
    terminal_verification_node_id: "term",
  };
}
function retryDescriptor(maxTraversals: number): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-sched-retry",
    revision_id: "rev-sched-retry",
    goal: "scheduler retry loop",
    nodes: [
      { ...executableNode("start", "agent"), max_attempts: 1 },
      { ...executableNode("work", "command"), max_attempts: 3 },
      { ...executableNode("give_up", "command"), max_attempts: 1 },
      { ...executableNode("term", "command"), max_attempts: 1 },
    ],
    edges: [
      { id: "e-start-work", kind: "fixed", from: "start", to: "work" },
      {
        id: "e-work-retry",
        kind: "back_edge",
        from: "work",
        to: "work",
        route: "retry",
        max_traversals: maxTraversals,
      },
      {
        id: "e-work-give-up",
        kind: "conditional",
        from: "work",
        to: "give_up",
        route: "give-up",
      },
      {
        id: "e-work-term",
        kind: "conditional",
        from: "work",
        to: "term",
        route: "success",
      },
      { id: "e-give-up-term", kind: "fixed", from: "give_up", to: "term" },
    ],
    entry_node_ids: ["start"],
    concurrency_limit: 1,
    terminal_verification_node_id: "term",
  };
}
function orderingDescriptor(): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-sched-order",
    revision_id: "rev-sched-order",
    goal: "scheduler ordering",
    nodes: [
      { ...executableNode("Zentry", "agent"), max_attempts: 1 },
      { ...executableNode("aentry", "command"), max_attempts: 1 },
      { ...executableNode("zentry", "agent"), max_attempts: 1 },
      { ...executableNode("term", "command"), max_attempts: 1 },
    ],
    edges: [
      { id: "e-Z-term", kind: "fixed", from: "Zentry", to: "term" },
      { id: "e-a-term", kind: "fixed", from: "aentry", to: "term" },
      { id: "e-z-term", kind: "fixed", from: "zentry", to: "term" },
    ],
    entry_node_ids: ["Zentry", "aentry", "zentry"],
    concurrency_limit: 3,
    terminal_verification_node_id: "term",
  };
}
function protoChainDescriptor(): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-proto-s",
    revision_id: "rev-proto-s",
    goal: "proto scheduler",
    nodes: [
      { ...executableNode("constructor", "command"), max_attempts: 1 },
      { ...executableNode("prototype", "command"), max_attempts: 1 },
      { ...executableNode("hasOwnProperty", "command"), max_attempts: 1 },
    ],
    edges: [
      { id: "e1", kind: "fixed", from: "constructor", to: "prototype" },
      { id: "e2", kind: "fixed", from: "prototype", to: "hasOwnProperty" },
    ],
    entry_node_ids: ["constructor"],
    concurrency_limit: 1,
    terminal_verification_node_id: "hasOwnProperty",
  };
}
function baseProjection(
  descriptor: SealedGraphDescriptor,
): GraphSchedulerProjection {
  return {
    descriptor_hash: descriptor.descriptor_hash,
    run_id: descriptor.run_id,
    revision_id: descriptor.revision_id,
    activations: {},
    cohorts: {},
    branch_tokens: {},
    traversal_counts: {},
    committed_transitions: {},
    terminal_verification_activation_ids: [],
  };
}
function expectCode(fn: () => unknown, code: GraphSchedulerErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GraphSchedulerError);
  expect((thrown as GraphSchedulerError).code).toBe(code);
}
const fanOutIdentities = {
  cohort_id: "coh-1",
  branch_token_ids: { "e-fan-b1": "tok-b1", "e-fan-b2": "tok-b2" },
  next_activation_ids: { "e-fan-b1": "act-b1", "e-fan-b2": "act-b2" },
};
function driveToJoin(
  descriptor: SealedGraphDescriptor,
): GraphSchedulerProjection {
  let p = initializeGraphProjection(descriptor, { fan: "act-fan" });
  p = beginActivationAttempt(descriptor, p, {
    activation_id: "act-fan",
    attempt_id: "at-fan-1",
  });
  p = applyNodeResult(descriptor, p, {
    activation_id: "act-fan",
    transition_id: "tr-fan",
    result: ok("at-fan-1"),
    identities: fanOutIdentities,
  }).projection;
  p = beginActivationAttempt(descriptor, p, {
    activation_id: "act-b1",
    attempt_id: "at-b1-1",
  });
  p = applyNodeResult(descriptor, p, {
    activation_id: "act-b1",
    transition_id: "tr-b1",
    result: ok("at-b1-1"),
    identities: {},
  }).projection;
  p = beginActivationAttempt(descriptor, p, {
    activation_id: "act-b2",
    attempt_id: "at-b2-1",
  });
  p = applyNodeResult(descriptor, p, {
    activation_id: "act-b2",
    transition_id: "tr-b2",
    result: ok("at-b2-1"),
    identities: { join_activation_id: "act-join" },
  }).projection;
  return p;
}
function driveToApproval(
  sealed: SealedGraphDescriptor,
): GraphSchedulerProjection {
  let p = initializeGraphProjection(sealed, { entry: "act-entry" });
  p = beginActivationAttempt(sealed, p, {
    activation_id: "act-entry",
    attempt_id: "at-entry",
  });
  return applyNodeResult(sealed, p, {
    activation_id: "act-entry",
    transition_id: "tr-entry",
    result: ok("at-entry"),
    identities: { next_activation_ids: { "e-entry-approval": "act-approval" } },
  }).projection;
}
function driveToWork(sealed: SealedGraphDescriptor): GraphSchedulerProjection {
  let p = initializeGraphProjection(sealed, { start: "act-start" });
  p = beginActivationAttempt(sealed, p, {
    activation_id: "act-start",
    attempt_id: "at-start",
  });
  return applyNodeResult(sealed, p, {
    activation_id: "act-start",
    transition_id: "tr-start",
    result: ok("at-start"),
    identities: { next_activation_ids: { "e-start-work": "act-work" } },
  }).projection;
}
function cyclicIdentities(): unknown {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

describe("S1 - initializeGraphProjection", () => {
  it("creates a bound projection with entry activations", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection = initializeGraphProjection(sealed, { fan: "act-fan" });
    expect(projection.descriptor_hash).toBe(sealed.descriptor_hash);
    expect(projection.run_id).toBe(sealed.run_id);
    expect(projection.revision_id).toBe(sealed.revision_id);
    expect(Object.keys(projection.activations)).toEqual(["act-fan"]);
    expect(projection.activations["act-fan"].status).toBe("ready");
    expect(projection.activations["act-fan"].traversal_owner_id).toBe(
      "act-fan",
    );
    expect(projection.committed_transitions).toEqual({});
  });
  it("throws missing_identity when an entry node has no identity", () => {
    expectCode(
      () => initializeGraphProjection(sealedOf(forkJoinDescriptor()), {}),
      "missing_identity",
    );
  });
  it("throws unexpected_identity for a non-entry identity key", () => {
    expectCode(
      () =>
        initializeGraphProjection(sealedOf(forkJoinDescriptor()), {
          fan: "act-fan",
          b1: "act-b1",
        }),
      "unexpected_identity",
    );
  });
  it("throws duplicate_identity when two entry nodes share an activation id", () => {
    expectCode(
      () =>
        initializeGraphProjection(sealedOf(orderingDescriptor()), {
          Zentry: "same",
          aentry: "same",
          zentry: "act-z",
        }),
      "duplicate_identity",
    );
  });
});
describe("S2 - descriptor binding", () => {
  it("throws descriptor_mismatch when descriptor and projection have different hashes", () => {
    const sealed = sealedOf(chainDescriptor(1));
    const projection = initializeGraphProjection(
      sealedOf(forkJoinDescriptor()),
      { fan: "act-fan" },
    );
    expectCode(
      () =>
        beginActivationAttempt(sealed, projection, {
          activation_id: "act-fan",
          attempt_id: "at-1",
        }),
      "descriptor_mismatch",
    );
  });
  it("throws descriptor_mismatch when the projection hash is tampered with", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection = initializeGraphProjection(sealed, { fan: "act-fan" });
    expectCode(
      () =>
        beginActivationAttempt(
          sealed,
          { ...projection, descriptor_hash: "f".repeat(64) },
          { activation_id: "act-fan", attempt_id: "at-1" },
        ),
      "descriptor_mismatch",
    );
  });
});
describe("S3 - begin/release attempt identities and budget", () => {
  it("begin creates a running attempt; release with the wrong attempt is fenced", () => {
    const sealed = sealedOf(chainDescriptor(3));
    let projection = initializeGraphProjection(sealed, { start: "act-start" });
    projection = beginActivationAttempt(sealed, projection, {
      activation_id: "act-start",
      attempt_id: "at-1",
    });
    expect(projection.activations["act-start"].status).toBe("running");
    expect(projection.activations["act-start"].active_attempt_id).toBe("at-1");
    expectCode(
      () =>
        releaseAttemptForRetry(sealed, projection, {
          activation_id: "act-start",
          attempt_id: "at-wrong",
        }),
      "attempt_fenced",
    );
    projection = releaseAttemptForRetry(sealed, projection, {
      activation_id: "act-start",
      attempt_id: "at-1",
    });
    expect(projection.activations["act-start"].status).toBe("ready");
    expect(
      projection.activations["act-start"].active_attempt_id,
    ).toBeUndefined();
  });
  it("begin after the descriptor-derived budget is exhausted throws max_attempts_exceeded", () => {
    const sealed = sealedOf(chainDescriptor(2));
    const projection: GraphSchedulerProjection = {
      ...baseProjection(sealed),
      activations: {
        "act-work": {
          activation_id: "act-work",
          node_id: "work",
          status: "ready",
          attempt_no: 2,
          attempt_ids: ["at-1", "at-2"],
          traversal_owner_id: "act-work",
        },
      },
    };
    expectCode(
      () =>
        beginActivationAttempt(sealed, projection, {
          activation_id: "act-work",
          attempt_id: "at-3",
        }),
      "max_attempts_exceeded",
    );
  });
  it("reusing an attempt id colliding with the global namespace throws duplicate_identity", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection: GraphSchedulerProjection = {
      ...baseProjection(sealed),
      activations: {
        "act-a": {
          activation_id: "act-a",
          node_id: "fan",
          status: "ready",
          attempt_no: 0,
          attempt_ids: [],
          traversal_owner_id: "act-a",
        },
        "act-b": {
          activation_id: "act-b",
          node_id: "b1",
          status: "ready",
          attempt_no: 0,
          attempt_ids: [],
          traversal_owner_id: "act-b",
        },
      },
    };
    expectCode(
      () =>
        beginActivationAttempt(sealed, projection, {
          activation_id: "act-a",
          attempt_id: "act-b",
        }),
      "duplicate_identity",
    );
  });
});
describe("S4 - begin rejects approval and join kinds", () => {
  it("begin on a human-approval node throws unsupported_node_kind", () => {
    expectCode(
      () =>
        beginActivationAttempt(
          sealedOf(approvalDescriptor()),
          driveToApproval(sealedOf(approvalDescriptor())),
          { activation_id: "act-approval", attempt_id: "at-approval" },
        ),
      "unsupported_node_kind",
    );
  });
  it("begin on a join node throws unsupported_node_kind", () => {
    expectCode(
      () =>
        beginActivationAttempt(
          sealedOf(forkJoinDescriptor()),
          driveToJoin(sealedOf(forkJoinDescriptor())),
          { activation_id: "act-join", attempt_id: "at-join" },
        ),
      "unsupported_node_kind",
    );
  });
});
describe("S5 - route selection", () => {
  it("follows a declared conditional route", () => {
    const sealed = sealedOf(retryDescriptor(3));
    let projection = beginActivationAttempt(sealed, driveToWork(sealed), {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    projection = applyNodeResult(sealed, projection, {
      activation_id: "act-work",
      transition_id: "tr-w-success",
      result: { ...ok("at-w1"), route: "success" },
      identities: { next_activation_ids: { "e-work-term": "act-term" } },
    }).projection;
    expect(projection.activations["act-term"].node_id).toBe("term");
    expect(
      projection.committed_transitions["tr-w-success"].selected_edge_ids,
    ).toEqual(["e-work-term"]);
  });
  it("missing route on a routed node throws route_required", () => {
    const sealed = sealedOf(retryDescriptor(3));
    const running = beginActivationAttempt(sealed, driveToWork(sealed), {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-work",
          transition_id: "tr-w",
          result: ok("at-w1"),
        }),
      "route_required",
    );
  });
  it("undeclared route throws undeclared_route", () => {
    const sealed = sealedOf(retryDescriptor(3));
    const running = beginActivationAttempt(sealed, driveToWork(sealed), {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-work",
          transition_id: "tr-w",
          result: { ...ok("at-w1"), route: "nope" },
        }),
      "undeclared_route",
    );
  });
  it("failed results cannot select routes", () => {
    const sealed = sealedOf(retryDescriptor(3));
    const running = beginActivationAttempt(sealed, driveToWork(sealed), {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-work",
          transition_id: "tr-w",
          result: {
            outcome: "failed",
            attempt_id: "at-w1",
            route: "success",
            evidence_refs: [],
          },
        }),
      "undeclared_route",
    );
  });
});
describe("S6 - traversal bound on back edges", () => {
  it("third retry over max_traversals: 2 throws traversal_bound_exceeded", () => {
    const sealed = sealedOf(retryDescriptor(2));
    let projection = driveToWork(sealed);
    const retry = (
      activationId: string,
      attemptId: string,
      transitionId: string,
      nextId: string,
    ): GraphSchedulerProjection =>
      applyNodeResult(
        sealed,
        beginActivationAttempt(sealed, projection, {
          activation_id: activationId,
          attempt_id: attemptId,
        }),
        {
          activation_id: activationId,
          transition_id: transitionId,
          result: { ...ok(attemptId), route: "retry" },
          identities: { next_activation_ids: { "e-work-retry": nextId } },
        },
      ).projection;
    projection = retry("act-work", "at-r1", "r1", "act-work-r1");
    projection = retry("act-work-r1", "at-r2", "r2", "act-work-r2");
    const running = beginActivationAttempt(sealed, projection, {
      activation_id: "act-work-r2",
      attempt_id: "at-r3",
    });
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-work-r2",
          transition_id: "r3",
          result: { ...ok("at-r3"), route: "retry" },
          identities: {
            next_activation_ids: { "e-work-retry": "act-work-r3" },
          },
        }),
      "traversal_bound_exceeded",
    );
  });
});
describe("S7 - fan-out: cohort, branch tokens, join activation", () => {
  it("creates cohort and tokens; branch activations ready; join only after all tokens arrive", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    let p = initializeGraphProjection(sealed, { fan: "act-fan" });
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-fan",
      attempt_id: "at-fan-1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-fan",
      transition_id: "tr-fan",
      result: ok("at-fan-1"),
      identities: fanOutIdentities,
    }).projection;
    expect(p.cohorts["coh-1"].expected_branch_token_ids).toEqual([
      "tok-b1",
      "tok-b2",
    ]);
    expect(p.cohorts["coh-1"].consumed).toBe(false);
    expect(p.branch_tokens["tok-b1"].status).toBe("active");
    expect(p.branch_tokens["tok-b1"].current_activation_id).toBe("act-b1");
    expect(p.branch_tokens["tok-b2"].status).toBe("active");
    expect(p.activations["act-b1"].status).toBe("ready");
    expect(p.activations["act-b2"].status).toBe("ready");
    expect(listReadyJoinActivations(sealed, p)).toEqual([]);
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-b1",
      attempt_id: "at-b1-1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-b1",
      transition_id: "tr-b1",
      result: ok("at-b1-1"),
      identities: {},
    }).projection;
    expect(p.branch_tokens["tok-b1"].status).toBe("arrived");
    expect(p.activations["act-join"]).toBeUndefined();
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-b2",
      attempt_id: "at-b2-1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-b2",
      transition_id: "tr-b2",
      result: ok("at-b2-1"),
      identities: { join_activation_id: "act-join" },
    }).projection;
    expect(p.branch_tokens["tok-b2"].status).toBe("arrived");
    expect(p.activations["act-join"].node_id).toBe("join");
    expect(p.activations["act-join"].status).toBe("ready");
    expect(p.activations["act-join"].cohort_id).toBe("coh-1");
    expect(p.cohorts["coh-1"].join_activation_id).toBe("act-join");
    expect(
      listReadyJoinActivations(sealed, p).map(
        (activation) => activation.activation_id,
      ),
    ).toEqual(["act-join"]);
  });
  it("branch_token_fenced when a stale token does not own the completing activation", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection: GraphSchedulerProjection = {
      ...baseProjection(sealed),
      activations: {
        "act-b1": {
          activation_id: "act-b1",
          node_id: "b1",
          status: "running",
          attempt_no: 1,
          attempt_ids: ["at-b1-1"],
          active_attempt_id: "at-b1-1",
          branch_token_id: "tok-b1",
          traversal_owner_id: "act-b1",
        },
      },
      branch_tokens: {
        "tok-b1": {
          branch_token_id: "tok-b1",
          cohort_id: "coh-1",
          branch_id: "br1",
          owner_join_id: "join",
          status: "active",
          current_activation_id: "act-someone-else",
        },
      },
      cohorts: {
        "coh-1": {
          cohort_id: "coh-1",
          fan_out_node_id: "fan",
          owner_join_id: "join",
          expected_branch_token_ids: ["tok-b1", "tok-b2"],
          consumed: false,
        },
      },
    };
    expectCode(
      () =>
        applyNodeResult(sealed, projection, {
          activation_id: "act-b1",
          transition_id: "tr-b1",
          result: ok("at-b1-1"),
        }),
      "branch_token_fenced",
    );
  });
});
describe("S8 - resolveJoin consumes exactly once", () => {
  it("consumes cohort and tokens exactly once and creates the next activation", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const result = resolveJoin(sealed, driveToJoin(sealed), {
      activation_id: "act-join",
      transition_id: "tr-join",
      identities: { next_activation_ids: { "e-join-term": "act-term" } },
    });
    const projection = result.projection;
    expect(result.transition.outcome).toBe("join_resolved");
    if (result.transition.outcome !== "join_resolved")
      throw new Error("unreachable");
    expect(result.transition.cohort_id).toBe("coh-1");
    expect(result.transition.selected_edge_ids).toEqual(["e-join-term"]);
    expect(result.transition.created_activation_ids).toEqual(["act-term"]);
    expect(result.transition.evidence_refs).toEqual([]);
    expect(result.transition).not.toHaveProperty("attempt_id");
    expect(projection.cohorts["coh-1"].consumed).toBe(true);
    expect(projection.branch_tokens["tok-b1"].status).toBe("consumed");
    expect(projection.branch_tokens["tok-b2"].status).toBe("consumed");
    expect(projection.branch_tokens["tok-b1"].consumed_by_activation_id).toBe(
      "act-join",
    );
    expect(projection.activations["act-join"].status).toBe("completed");
    expect(projection.activations["act-term"].status).toBe("ready");
  });
  it("second resolve with a different transition id throws join_already_consumed", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection = resolveJoin(sealed, driveToJoin(sealed), {
      activation_id: "act-join",
      transition_id: "tr-join",
      identities: { next_activation_ids: { "e-join-term": "act-term" } },
    }).projection;
    expectCode(
      () =>
        resolveJoin(sealed, projection, {
          activation_id: "act-join",
          transition_id: "tr-join-2",
          identities: { next_activation_ids: { "e-join-term": "act-term-2" } },
        }),
      "join_already_consumed",
    );
  });
});
describe("S9 - replay fencing on record-bearing mutations", () => {
  const runningChain = (
    sealed: SealedGraphDescriptor,
  ): GraphSchedulerProjection =>
    beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-start" },
    );
  it("identical replay returns replayed: true with the same projection", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const input = {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-start"),
      identities: { next_activation_ids: { "e-start-work": "act-work" } },
    };
    const first = applyNodeResult(sealed, runningChain(sealed), input);
    const replay = applyNodeResult(sealed, first.projection, input);
    expect(replay.replayed).toBe(true);
    expect(replay.projection).toBe(first.projection);
    expect(replay.transition).toBe(first.transition);
  });
  it("same transition id with changed identities throws transition_fenced", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const input = {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-start"),
      identities: { next_activation_ids: { "e-start-work": "act-work" } },
    };
    const first = applyNodeResult(sealed, runningChain(sealed), input);
    expectCode(
      () =>
        applyNodeResult(sealed, first.projection, {
          ...input,
          identities: {
            next_activation_ids: { "e-start-work": "act-work-other" },
          },
        }),
      "transition_fenced",
    );
  });
  it("committed transitions carry fingerprint_version 1 and the descriptor hash", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const result = applyNodeResult(sealed, runningChain(sealed), {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-start"),
      identities: { next_activation_ids: { "e-start-work": "act-work" } },
    });
    expect(result.transition.fingerprint_version).toBe(1);
    expect(result.transition.descriptor_hash).toBe(sealed.descriptor_hash);
    expect(result.transition.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
describe("S10 - dedicated human approval transition (stage-04 record shapes)", () => {
  it("approved creates the next activation and commits an exact approved record", () => {
    const sealed = sealedOf(approvalDescriptor());
    const projection = driveToApproval(sealed);
    expect(
      listReadyApprovalActivations(sealed, projection).map(
        (activation) => activation.activation_id,
      ),
    ).toEqual(["act-approval"]);
    const result = applyHumanApproval(sealed, projection, {
      activation_id: "act-approval",
      transition_id: "tr-approval",
      decision: {
        decision: "approved",
        evidence_refs: [...EVIDENCE],
        output_summary: "release approved",
      },
      identities: { next_activation_ids: { "e-approval-term": "act-term" } },
    });
    expect(result.transition.outcome).toBe("approved");
    if (result.transition.outcome !== "approved")
      throw new Error("unreachable");
    expect(result.transition.evidence_refs.length).toBeGreaterThanOrEqual(1);
    expect(result.transition.selected_edge_ids).toEqual(["e-approval-term"]);
    expect(result.transition.created_activation_ids).toEqual(["act-term"]);
    expect(result.transition.output_summary).toBe("release approved");
    expect(result.transition).not.toHaveProperty("attempt_id");
    expect(result.transition).not.toHaveProperty("summary");
    expect(result.projection.activations["act-approval"].status).toBe(
      "completed",
    );
    expect(result.projection.activations["act-term"].status).toBe("ready");
  });
  it("denied terminal-fails the activation and commits an exact denied record", () => {
    const sealed = sealedOf(approvalDescriptor());
    const result = applyHumanApproval(sealed, driveToApproval(sealed), {
      activation_id: "act-approval",
      transition_id: "tr-denied",
      decision: {
        decision: "denied",
        evidence_refs: [...EVIDENCE],
        output_summary: "blocked by reviewer",
      },
    });
    expect(result.transition.outcome).toBe("denied");
    if (result.transition.outcome !== "denied") throw new Error("unreachable");
    expect(result.transition.evidence_refs.length).toBeGreaterThanOrEqual(1);
    expect(result.transition.selected_edge_ids).toEqual([]);
    expect(result.transition.created_activation_ids).toEqual([]);
    expect(result.transition.output_summary).toBe("blocked by reviewer");
    expect(result.transition).not.toHaveProperty("attempt_id");
    expect(result.projection.activations["act-approval"].status).toBe("failed");
  });
  it("approved without evidence throws terminal_evidence_required", () => {
    const sealed = sealedOf(approvalDescriptor());
    expectCode(
      () =>
        applyHumanApproval(sealed, driveToApproval(sealed), {
          activation_id: "act-approval",
          transition_id: "tr-approval",
          decision: { decision: "approved", evidence_refs: [] },
          identities: {
            next_activation_ids: { "e-approval-term": "act-term" },
          },
        }),
      "terminal_evidence_required",
    );
  });
  it("applyNodeResult on an approval node throws approval_requires_dedicated_transition", () => {
    const sealed = sealedOf(approvalDescriptor());
    expectCode(
      () =>
        applyNodeResult(sealed, driveToApproval(sealed), {
          activation_id: "act-approval",
          transition_id: "tr-x",
          result: ok("at-x"),
        }),
      "approval_requires_dedicated_transition",
    );
  });
});
describe("S11 - terminal verification requires evidence", () => {
  it("terminal success without evidence throws terminal_evidence_required", () => {
    const sealed = sealedOf(chainDescriptor(3));
    let p = initializeGraphProjection(sealed, { start: "act-start" });
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-start",
      attempt_id: "at-start",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-start"),
      identities: { next_activation_ids: { "e-start-work": "act-work" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-work",
      attempt_id: "at-work",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-work",
      transition_id: "tr-work",
      result: ok("at-work"),
      identities: { next_activation_ids: { "e-work-term": "act-term" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-term",
      attempt_id: "at-term",
    });
    expectCode(
      () =>
        applyNodeResult(sealed, p, {
          activation_id: "act-term",
          transition_id: "tr-term",
          result: ok("at-term"),
        }),
      "terminal_evidence_required",
    );
  });
});
describe("S12 - A3 retry semantics", () => {
  it("first failure returns to ready; budget-exhausted failure terminal-fails", () => {
    const sealed = sealedOf(chainDescriptor(2));
    let p = beginActivationAttempt(sealed, driveToWork(sealed), {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-work",
      transition_id: "tr-w1",
      result: { outcome: "failed", attempt_id: "at-w1", evidence_refs: [] },
    }).projection;
    expect(p.activations["act-work"].status).toBe("ready");
    expect(isGraphSucceeded(sealed, p)).toBe(false);
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-work",
      attempt_id: "at-w2",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-work",
      transition_id: "tr-w2",
      result: { outcome: "failed", attempt_id: "at-w2", evidence_refs: [] },
    }).projection;
    expect(p.activations["act-work"].status).toBe("failed");
    expect(p.activations["act-work"].active_attempt_id).toBeUndefined();
    expect(isGraphSucceeded(sealed, p)).toBe(false);
  });
});
describe("S13 - deterministic code-unit ordering", () => {
  it("ready lists sort by code-unit comparison (Z < a < z), not locale", () => {
    const sealed = sealedOf(orderingDescriptor());
    const projection = initializeGraphProjection(sealed, {
      Zentry: "Z-act",
      aentry: "a-act",
      zentry: "z-act",
    });
    const ids = listReadyExecutableActivations(sealed, projection).map(
      (a) => a.activation_id,
    );
    expect(ids).toEqual(["Z-act", "a-act", "z-act"]);
    expect(
      listReadyExecutableActivations(sealed, projection).map(
        (a) => a.activation_id,
      ),
    ).toEqual(ids);
  });
});
describe("S14 - global identity namespace", () => {
  const twoActivations = (
    sealed: SealedGraphDescriptor,
  ): GraphSchedulerProjection => ({
    ...baseProjection(sealed),
    activations: {
      "act-a": {
        activation_id: "act-a",
        node_id: "start",
        status: "ready",
        attempt_no: 0,
        attempt_ids: [],
        traversal_owner_id: "act-a",
      },
      "act-b": {
        activation_id: "act-b",
        node_id: "work",
        status: "ready",
        attempt_no: 0,
        attempt_ids: [],
        traversal_owner_id: "act-b",
      },
    },
  });
  it("attempt id colliding with an activation id throws duplicate_identity", () => {
    expectCode(
      () =>
        beginActivationAttempt(
          sealedOf(chainDescriptor(3)),
          twoActivations(sealedOf(chainDescriptor(3))),
          { activation_id: "act-a", attempt_id: "act-b" },
        ),
      "duplicate_identity",
    );
  });
  it("transition id colliding with a token id throws duplicate_identity", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    expectCode(
      () =>
        resolveJoin(sealed, driveToJoin(sealed), {
          activation_id: "act-join",
          transition_id: "tok-b1",
          identities: { next_activation_ids: { "e-join-term": "act-term" } },
        }),
      "duplicate_identity",
    );
  });
  it("cohort id colliding with an activation id throws duplicate_identity", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { fan: "act-fan" }),
      { activation_id: "act-fan", attempt_id: "at-fan-1" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-fan",
          transition_id: "tr-fan",
          result: ok("at-fan-1"),
          identities: {
            cohort_id: "act-fan",
            branch_token_ids: { "e-fan-b1": "tok-b1", "e-fan-b2": "tok-b2" },
            next_activation_ids: { "e-fan-b1": "act-b1", "e-fan-b2": "act-b2" },
          },
        }),
      "duplicate_identity",
    );
  });
  it("undeclared identity-map key throws undeclared_identity_key", () => {
    const sealed = sealedOf(retryDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-start" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "tr-start",
          result: ok("at-start"),
          identities: { next_activation_ids: { "e-nope": "act-x" } },
        }),
      "undeclared_identity_key",
    );
  });
  it("missing required identity throws missing_identity", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-start" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "tr-start",
          result: ok("at-start"),
          identities: {},
        }),
      "missing_identity",
    );
  });
});
describe("S15 - purity: no mutation of inputs, including on thrown paths", () => {
  it("leaves the input projection and descriptor unchanged after success", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const projection = initializeGraphProjection(sealed, {
      start: "act-start",
    });
    const snapshot = JSON.stringify(projection);
    const descriptorSnapshot = JSON.stringify(sealed);
    const running = beginActivationAttempt(sealed, projection, {
      activation_id: "act-start",
      attempt_id: "at-start",
    });
    expect(JSON.stringify(projection)).toBe(snapshot);
    applyNodeResult(sealed, running, {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-start"),
      identities: { next_activation_ids: { "e-start-work": "act-work" } },
    });
    expect(JSON.stringify(sealed)).toBe(descriptorSnapshot);
  });
  it("leaves the input projection unchanged after a thrown transition", () => {
    const sealed = sealedOf(retryDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-start" },
    );
    const snapshot = JSON.stringify(running);
    expect(() =>
      applyNodeResult(sealed, running, {
        activation_id: "act-start",
        transition_id: "tr-start",
        result: { ...ok("at-start"), route: "nope" },
        identities: { next_activation_ids: { "e-start-work": "act-work" } },
      }),
    ).toThrow(GraphSchedulerError);
    expect(JSON.stringify(running)).toBe(snapshot);
  });
});
describe("S16 - atomic final-budget release", () => {
  it("release with budget remaining returns to ready; release at final budget terminal-fails", () => {
    const sealed = sealedOf(chainDescriptor(2));
    let p = beginActivationAttempt(sealed, driveToWork(sealed), {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    p = releaseAttemptForRetry(sealed, p, {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    expect(p.activations["act-work"].status).toBe("ready");
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-work",
      attempt_id: "at-w2",
    });
    expect(p.activations["act-work"].status).toBe("running");
    p = releaseAttemptForRetry(sealed, p, {
      activation_id: "act-work",
      attempt_id: "at-w2",
    });
    expect(p.activations["act-work"].status).toBe("failed");
    expect(p.activations["act-work"].active_attempt_id).toBeUndefined();
    expect(listReadyExecutableActivations(sealed, p)).toEqual([]);
    expectCode(
      () =>
        beginActivationAttempt(sealed, p, {
          activation_id: "act-work",
          attempt_id: "at-w3",
        }),
      "activation_not_ready",
    );
    expect(Object.keys(p.committed_transitions)).toEqual(["tr-start"]);
  });
});
describe("S17 - begin/release plain-projection scope", () => {
  it("begin/release add no committed transitions and no begin/release outcomes exist", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const projection = initializeGraphProjection(sealed, {
      start: "act-start",
    });
    const committedBefore = JSON.stringify(projection.committed_transitions);
    const running = beginActivationAttempt(sealed, projection, {
      activation_id: "act-start",
      attempt_id: "at-1",
    });
    expect(JSON.stringify(running.committed_transitions)).toBe(committedBefore);
    const released = releaseAttemptForRetry(sealed, running, {
      activation_id: "act-start",
      attempt_id: "at-1",
    });
    expect(JSON.stringify(released.committed_transitions)).toBe(
      committedBefore,
    );
    expect(Object.keys(released.committed_transitions)).toEqual([]);
  });
  it("repeated begin on an already-running activation throws activation_not_ready", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-1" },
    );
    expectCode(
      () =>
        beginActivationAttempt(sealed, running, {
          activation_id: "act-start",
          attempt_id: "at-2",
        }),
      "activation_not_ready",
    );
  });
  it("begin/release inputs carry no transition_id or max_attempts (compile-time)", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const projection = initializeGraphProjection(sealed, {
      start: "act-start",
    });
    const compileTimeOnly = (): void => {
      beginActivationAttempt(sealed, projection, {
        activation_id: "act-start",
        attempt_id: "at-1",
        // @ts-expect-error BeginActivationAttemptInput carries no transition_id
        transition_id: "tr-x",
      });
      beginActivationAttempt(sealed, projection, {
        activation_id: "act-start",
        attempt_id: "at-1",
        // @ts-expect-error BeginActivationAttemptInput carries no max_attempts (budget is descriptor-derived)
        max_attempts: 5,
      });
      releaseAttemptForRetry(sealed, projection, {
        activation_id: "act-start",
        attempt_id: "at-1",
        // @ts-expect-error ReleaseAttemptForRetryInput carries no transition_id
        transition_id: "tr-x",
      });
    };
    expect(typeof compileTimeOnly).toBe("function");
  });
});
describe("S18 - parser and identity failure mapping (closed errors)", () => {
  const setup = (): {
    sealed: SealedGraphDescriptor;
    running: GraphSchedulerProjection;
  } => {
    const sealed = sealedOf(chainDescriptor(3));
    return {
      sealed,
      running: beginActivationAttempt(
        sealed,
        initializeGraphProjection(sealed, { start: "act-start" }),
        { activation_id: "act-start", attempt_id: "at-1" },
      ),
    };
  };
  it("malformed node results map to invalid_input, never ZodError", () => {
    const { sealed, running } = setup();
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "tr-1",
          result: {
            outcome: "succeeded",
            attempt_id: "at-1",
            evidence_refs: [],
            // @ts-expect-error deliberate malformed shape
            extra: true,
          },
        }),
      "invalid_input",
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "tr-2",
          result: {
            outcome: "succeeded",
            attempt_id: "bad id!",
            evidence_refs: [],
          },
        }),
      "invalid_input",
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "tr-3",
          result: {
            outcome: "succeeded",
            attempt_id: "at-1",
            // @ts-expect-error deliberate malformed shape
            evidence_refs: "nope",
          },
        }),
      "invalid_input",
    );
  });
  it("malformed approval decisions map to invalid_input", () => {
    const sealed = sealedOf(approvalDescriptor());
    expectCode(
      () =>
        applyHumanApproval(sealed, driveToApproval(sealed), {
          activation_id: "act-approval",
          transition_id: "tr-approval",
          decision: {
            decision: "approved",
            evidence_refs: [],
            // @ts-expect-error deliberate malformed shape
            extra: true,
          },
        }),
      "invalid_input",
    );
  });
  it("identity values failing isValidStableId map to invalid_input", () => {
    const { sealed, running } = setup();
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "tr-1",
          result: ok("at-1"),
          identities: { next_activation_ids: { "e-start-work": "bad id!" } },
        }),
      "invalid_input",
    );
  });
  it("malformed entry activation ids map to invalid_input", () => {
    expectCode(
      () =>
        initializeGraphProjection(sealedOf(chainDescriptor(3)), {
          start: "bad id!",
        }),
      "invalid_input",
    );
    expectCode(
      () =>
        initializeGraphProjection(sealedOf(chainDescriptor(3)), {
          start: 1n as unknown as string,
        }),
      "invalid_input",
    );
    for (const malformed of [
      null,
      [],
      new Date(),
      Object.create({ start: "act-start" }),
    ]) {
      expectCode(
        () =>
          initializeGraphProjection(
            sealedOf(chainDescriptor(3)),
            malformed as unknown as Readonly<Record<string, string>>,
          ),
        "invalid_input",
      );
    }
  });
});
describe("S19 - hash-fenced reads", () => {
  const reads = (
    descriptor: SealedGraphDescriptor,
    projection: GraphSchedulerProjection,
  ): (() => unknown)[] => [
    () => listReadyExecutableActivations(descriptor, projection),
    () => listReadyApprovalActivations(descriptor, projection),
    () => listReadyJoinActivations(descriptor, projection),
    () => isGraphSucceeded(descriptor, projection),
  ];
  it("all four descriptor-dependent reads throw descriptor_mismatch on hash drift", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection = initializeGraphProjection(sealed, { fan: "act-fan" });
    for (const read of reads(sealedOf(chainDescriptor(1)), projection))
      expectCode(read, "descriptor_mismatch");
  });
  it("all four reads behave normally with a matching descriptor", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection = initializeGraphProjection(sealed, { fan: "act-fan" });
    expect(
      listReadyExecutableActivations(sealed, projection).map(
        (a) => a.activation_id,
      ),
    ).toEqual(["act-fan"]);
    expect(listReadyApprovalActivations(sealed, projection)).toEqual([]);
    expect(listReadyJoinActivations(sealed, projection)).toEqual([]);
    expect(isGraphSucceeded(sealed, projection)).toBe(false);
  });
});
describe("S20 - persisted sealed input flows into the scheduler without assertion", () => {
  it("parseSealedGraphDescriptor output initializes a projection and drives a full happy path", () => {
    const sealed = parseSealedGraphDescriptor(
      JSON.parse(JSON.stringify(sealGraphDescriptor(forkJoinDescriptor()))),
    ); // producer return type: SealedGraphDescriptor
    let p = initializeGraphProjection(sealed, { fan: "act-fan" });
    expect(p.descriptor_hash).toBe(sealed.descriptor_hash);
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-fan",
      attempt_id: "at-fan-1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-fan",
      transition_id: "tr-fan",
      result: ok("at-fan-1"),
      identities: fanOutIdentities,
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-b1",
      attempt_id: "at-b1-1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-b1",
      transition_id: "tr-b1",
      result: ok("at-b1-1"),
      identities: {},
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-b2",
      attempt_id: "at-b2-1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-b2",
      transition_id: "tr-b2",
      result: ok("at-b2-1"),
      identities: { join_activation_id: "act-join" },
    }).projection;
    p = resolveJoin(sealed, p, {
      activation_id: "act-join",
      transition_id: "tr-join",
      identities: { next_activation_ids: { "e-join-term": "act-term" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-term",
      attempt_id: "at-term",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-term",
      transition_id: "tr-term",
      result: { ...ok("at-term"), evidence_refs: [...EVIDENCE] },
    }).projection;
    expect(isGraphSucceeded(sealed, p)).toBe(true);
    expect(p.descriptor_hash).toBe(sealed.descriptor_hash);
    expect(Object.keys(p.committed_transitions).sort()).toEqual(
      ["tr-fan", "tr-b1", "tr-b2", "tr-join", "tr-term"].sort(),
    );
  });
});
describe("S20b - loop descriptor give-up exit completes successfully", () => {
  it("loop descriptor give-up exit completes successfully with evidence", () => {
    const sealed = sealedOf(loopDescriptor());
    let p = initializeGraphProjection(sealed, { start: "act-start" });
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-start",
      attempt_id: "at-start",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-start"),
      identities: { next_activation_ids: { "e-start-work": "act-work" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-work",
      attempt_id: "at-w1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-work",
      transition_id: "tr-w1",
      result: { ...ok("at-w1"), route: "give-up" },
      identities: { next_activation_ids: { "e-work-give-up": "act-give-up" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-give-up",
      attempt_id: "at-g1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-give-up",
      transition_id: "tr-g1",
      result: ok("at-g1"),
      identities: { next_activation_ids: { "e-give-up-term": "act-term" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "act-term",
      attempt_id: "at-term",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "act-term",
      transition_id: "tr-term",
      result: { ...ok("at-term"), evidence_refs: [...EVIDENCE] },
    }).projection;
    expect(isGraphSucceeded(sealed, p)).toBe(true);
  });
});
describe("S21 - same-mutation identity collisions (transition id shares the local namespace)", () => {
  it("node result: created activation id equal to the transition id throws duplicate_identity", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-start" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "X",
          result: ok("at-start"),
          identities: { next_activation_ids: { "e-start-work": "X" } },
        }),
      "duplicate_identity",
    );
  });
  it("fan-out: cohort id equal to the transition id throws duplicate_identity", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { fan: "act-fan" }),
      { activation_id: "act-fan", attempt_id: "at-fan-1" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-fan",
          transition_id: "X",
          result: ok("at-fan-1"),
          identities: {
            cohort_id: "X",
            branch_token_ids: { "e-fan-b1": "tok-b1", "e-fan-b2": "tok-b2" },
            next_activation_ids: { "e-fan-b1": "act-b1", "e-fan-b2": "act-b2" },
          },
        }),
      "duplicate_identity",
    );
  });
  it("fan-out: branch token id equal to the transition id throws duplicate_identity", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { fan: "act-fan" }),
      { activation_id: "act-fan", attempt_id: "at-fan-1" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-fan",
          transition_id: "X",
          result: ok("at-fan-1"),
          identities: {
            cohort_id: "coh-X",
            branch_token_ids: { "e-fan-b1": "X", "e-fan-b2": "tok-b2" },
            next_activation_ids: { "e-fan-b1": "act-b1", "e-fan-b2": "act-b2" },
          },
        }),
      "duplicate_identity",
    );
  });
  it("fan-out: branch activation id equal to the transition id throws duplicate_identity", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { fan: "act-fan" }),
      { activation_id: "act-fan", attempt_id: "at-fan-1" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-fan",
          transition_id: "X",
          result: ok("at-fan-1"),
          identities: {
            cohort_id: "coh-X",
            branch_token_ids: { "e-fan-b1": "tok-b1", "e-fan-b2": "tok-b2" },
            next_activation_ids: { "e-fan-b1": "X", "e-fan-b2": "act-b2" },
          },
        }),
      "duplicate_identity",
    );
  });
  it("approval: next activation id equal to the transition id throws duplicate_identity", () => {
    const sealed = sealedOf(approvalDescriptor());
    expectCode(
      () =>
        applyHumanApproval(sealed, driveToApproval(sealed), {
          activation_id: "act-approval",
          transition_id: "X",
          decision: { decision: "approved", evidence_refs: [...EVIDENCE] },
          identities: { next_activation_ids: { "e-approval-term": "X" } },
        }),
      "duplicate_identity",
    );
  });
  it("join: next activation id equal to the transition id throws duplicate_identity", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    expectCode(
      () =>
        resolveJoin(sealed, driveToJoin(sealed), {
          activation_id: "act-join",
          transition_id: "X",
          identities: { next_activation_ids: { "e-join-term": "X" } },
        }),
      "duplicate_identity",
    );
  });
});
describe("S22 - malformed identity values map to invalid_input in all record-bearing mutations", () => {
  it("cyclic identities map to invalid_input on applyNodeResult", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-start" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "act-start",
          transition_id: "tr-1",
          result: ok("at-start"),
          identities:
            cyclicIdentities() as unknown as SchedulerTransitionIdentities,
        }),
      "invalid_input",
    );
  });
  it("cyclic identities map to invalid_input on applyHumanApproval", () => {
    const sealed = sealedOf(approvalDescriptor());
    expectCode(
      () =>
        applyHumanApproval(sealed, driveToApproval(sealed), {
          activation_id: "act-approval",
          transition_id: "tr-1",
          decision: { decision: "approved", evidence_refs: [...EVIDENCE] },
          identities:
            cyclicIdentities() as unknown as SchedulerTransitionIdentities,
        }),
      "invalid_input",
    );
  });
  it("cyclic identities map to invalid_input on resolveJoin", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    expectCode(
      () =>
        resolveJoin(sealed, driveToJoin(sealed), {
          activation_id: "act-join",
          transition_id: "tr-1",
          identities:
            cyclicIdentities() as unknown as SchedulerTransitionIdentities,
        }),
      "invalid_input",
    );
  });
  it("BigInt/function/symbol identity values map to invalid_input via validation", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-start" },
    );
    for (const bad of [1n, (): void => {}, Symbol("s")]) {
      expectCode(
        () =>
          applyNodeResult(sealed, running, {
            activation_id: "act-start",
            transition_id: "tr-1",
            result: ok("at-start"),
            identities: {
              next_activation_ids: { "e-start-work": bad as unknown as string },
            },
          }),
        "invalid_input",
      );
    }
  });
});
describe("S23 - run/revision mismatch fenced in all entrypoints", () => {
  const allEntrypoints = (
    sealed: SealedGraphDescriptor,
    projection: GraphSchedulerProjection,
  ): (() => unknown)[] => [
    () =>
      beginActivationAttempt(sealed, projection, {
        activation_id: "act-fan",
        attempt_id: "at-1",
      }),
    () =>
      releaseAttemptForRetry(sealed, projection, {
        activation_id: "act-fan",
        attempt_id: "at-1",
      }),
    () =>
      applyNodeResult(sealed, projection, {
        activation_id: "act-fan",
        transition_id: "tr-1",
        result: ok("at-1"),
      }),
    () =>
      applyHumanApproval(sealed, projection, {
        activation_id: "act-fan",
        transition_id: "tr-1",
        decision: { decision: "approved", evidence_refs: [...EVIDENCE] },
      }),
    () =>
      resolveJoin(sealed, projection, {
        activation_id: "act-fan",
        transition_id: "tr-1",
      }),
    () => listReadyExecutableActivations(sealed, projection),
    () => listReadyApprovalActivations(sealed, projection),
    () => listReadyJoinActivations(sealed, projection),
    () => isGraphSucceeded(sealed, projection),
  ];
  it("run_id mismatch throws descriptor_mismatch everywhere", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection = initializeGraphProjection(sealed, { fan: "act-fan" });
    for (const call of allEntrypoints(sealed, {
      ...projection,
      run_id: "other-run",
    }))
      expectCode(call, "descriptor_mismatch");
  });
  it("revision_id mismatch throws descriptor_mismatch everywhere", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const projection = initializeGraphProjection(sealed, { fan: "act-fan" });
    for (const call of allEntrypoints(sealed, {
      ...projection,
      revision_id: "other-rev",
    }))
      expectCode(call, "descriptor_mismatch");
  });
});
describe("S24 - approval replay fencing", () => {
  const approvalInput: ApplyHumanApprovalInput = {
    activation_id: "act-approval",
    transition_id: "tr-approval",
    decision: { decision: "approved", evidence_refs: [...EVIDENCE] },
    identities: { next_activation_ids: { "e-approval-term": "act-term" } },
  };
  it("identical approval replay returns replayed with the same projection", () => {
    const sealed = sealedOf(approvalDescriptor());
    const first = applyHumanApproval(
      sealed,
      driveToApproval(sealed),
      approvalInput,
    );
    const replay = applyHumanApproval(sealed, first.projection, approvalInput);
    expect(replay.replayed).toBe(true);
    expect(replay.projection).toBe(first.projection);
    expect(replay.transition).toBe(first.transition);
  });
  it("changed decision throws transition_fenced", () => {
    const sealed = sealedOf(approvalDescriptor());
    const first = applyHumanApproval(
      sealed,
      driveToApproval(sealed),
      approvalInput,
    );
    expectCode(
      () =>
        applyHumanApproval(sealed, first.projection, {
          ...approvalInput,
          decision: { decision: "denied", evidence_refs: [...EVIDENCE] },
        }),
      "transition_fenced",
    );
  });
});
describe("S25 - join replay fencing", () => {
  const joinInput = {
    activation_id: "act-join",
    transition_id: "tr-join",
    identities: { next_activation_ids: { "e-join-term": "act-term" } },
  };
  it("identical join replay returns replayed with the same projection", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const first = resolveJoin(sealed, driveToJoin(sealed), joinInput);
    const replay = resolveJoin(sealed, first.projection, joinInput);
    expect(replay.replayed).toBe(true);
    expect(replay.projection).toBe(first.projection);
    expect(replay.transition).toBe(first.transition);
  });
  it("changed identities throws transition_fenced", () => {
    const sealed = sealedOf(forkJoinDescriptor());
    const first = resolveJoin(sealed, driveToJoin(sealed), joinInput);
    expectCode(
      () =>
        resolveJoin(sealed, first.projection, {
          ...joinInput,
          identities: { next_activation_ids: { "e-join-term": "act-term-2" } },
        }),
      "transition_fenced",
    );
  });
});
describe("S26 - prototype-named stable ids work end to end", () => {
  it("constructor/prototype activation and transition ids drive a full path", () => {
    const sealed = sealedOf(protoChainDescriptor());
    expect(verifyDescriptorHash(sealed)).toBe(true);
    let p = initializeGraphProjection(sealed, { constructor: "constructor" });
    expect(
      listReadyExecutableActivations(sealed, p).map((a) => a.activation_id),
    ).toEqual(["constructor"]);
    p = beginActivationAttempt(sealed, p, {
      activation_id: "constructor",
      attempt_id: "at-1",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "constructor",
      transition_id: "t1",
      result: ok("at-1"),
      identities: { next_activation_ids: { e1: "prototype" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "prototype",
      attempt_id: "at-2",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "prototype",
      transition_id: "t2",
      result: ok("at-2"),
      identities: { next_activation_ids: { e2: "hasOwnProperty" } },
    }).projection;
    p = beginActivationAttempt(sealed, p, {
      activation_id: "hasOwnProperty",
      attempt_id: "at-3",
    });
    p = applyNodeResult(sealed, p, {
      activation_id: "hasOwnProperty",
      transition_id: "t3",
      result: { ...ok("at-3"), evidence_refs: [...EVIDENCE] },
    }).projection;
    expect(isGraphSucceeded(sealed, p)).toBe(true);
  });
  it("missing prototype-named identity still throws missing_identity", () => {
    const sealed = sealedOf(protoChainDescriptor());
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { constructor: "constructor" }),
      { activation_id: "constructor", attempt_id: "at-1" },
    );
    expectCode(
      () =>
        applyNodeResult(sealed, running, {
          activation_id: "constructor",
          transition_id: "t1",
          result: ok("at-1"),
          identities: {},
        }),
      "missing_identity",
    );
  });
});

describe("S27 - malformed containers and projections stay inside the closed error boundary", () => {
  it("rejects null, non-plain, and inherited identity maps as invalid_input", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const running = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-1" },
    );
    const base = {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-1"),
    };
    for (const identities of [
      null,
      new Date(),
      { next_activation_ids: Object.create({ "e-start-work": "act-work" }) },
    ]) {
      expectCode(
        () =>
          applyNodeResult(sealed, running, {
            ...base,
            identities:
              identities as unknown as ApplyNodeResultInput["identities"],
          }),
        "invalid_input",
      );
    }
  });

  it("maps non-cloneable caller projection values to invalid_input", () => {
    const sealed = sealedOf(chainDescriptor(3));
    let projection = beginActivationAttempt(
      sealed,
      initializeGraphProjection(sealed, { start: "act-start" }),
      { activation_id: "act-start", attempt_id: "at-1" },
    );
    projection = applyNodeResult(sealed, projection, {
      activation_id: "act-start",
      transition_id: "tr-start",
      result: ok("at-1"),
      identities: { next_activation_ids: { "e-start-work": "act-work" } },
    }).projection;
    const transition = { ...projection.committed_transitions["tr-start"] };
    (transition as unknown as Record<string, unknown>).non_cloneable = () =>
      undefined;
    const malformed = {
      ...projection,
      committed_transitions: {
        ...projection.committed_transitions,
        "tr-start": transition,
      },
    };
    expectCode(
      () =>
        beginActivationAttempt(sealed, malformed, {
          activation_id: "act-work",
          attempt_id: "at-work",
        }),
      "invalid_input",
    );
  });
});

describe("S28 - non-JSON direct ids stay inside the closed error boundary", () => {
  it("maps Symbol activation and attempt ids to invalid_input", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const projection = initializeGraphProjection(sealed, {
      start: "act-start",
    });
    expectCode(
      () =>
        beginActivationAttempt(sealed, projection, {
          activation_id: Symbol("activation") as unknown as string,
          attempt_id: "at-1",
        }),
      "invalid_input",
    );
    const running = beginActivationAttempt(sealed, projection, {
      activation_id: "act-start",
      attempt_id: "at-1",
    });
    expectCode(
      () =>
        releaseAttemptForRetry(sealed, running, {
          activation_id: "act-start",
          attempt_id: Symbol("attempt") as unknown as string,
        }),
      "invalid_input",
    );
  });

  it("maps malformed projection bindings and stored traversal owners to invalid_input", () => {
    const sealed = sealedOf(chainDescriptor(3));
    const projection = initializeGraphProjection(sealed, {
      start: "act-start",
    });
    expectCode(
      () =>
        listReadyExecutableActivations(sealed, {
          ...projection,
          run_id: Symbol("run") as unknown as string,
        }),
      "invalid_input",
    );
    const malformed = {
      ...projection,
      activations: {
        ...projection.activations,
        "act-start": {
          ...projection.activations["act-start"],
          traversal_owner_id: Symbol("owner") as unknown as string,
        },
      },
    };
    expectCode(
      () =>
        beginActivationAttempt(sealed, malformed, {
          activation_id: "act-start",
          attempt_id: "at-1",
        }),
      "invalid_input",
    );
  });
});

describe("S29 - traversal counter key closed error boundary", () => {
  it("returns a deterministic key for valid stable ids", () => {
    const sealed = sealedOf(retryDescriptor(2));
    const projection = initializeGraphProjection(sealed, {
      start: "act-start",
    });
    expect(
      traversalCounterKey(projection.activations["act-start"], sealed.edges[0]),
    ).toBe('["act-start","e-start-work"]');
  });

  it("maps non-string traversal owner and edge ids to invalid_input", () => {
    const sealed = sealedOf(retryDescriptor(2));
    const projection = initializeGraphProjection(sealed, {
      start: "act-start",
    });
    expectCode(
      () =>
        traversalCounterKey(
          {
            ...projection.activations["act-start"],
            traversal_owner_id: Symbol("owner") as unknown as string,
          },
          sealed.edges[0],
        ),
      "invalid_input",
    );
    expectCode(
      () =>
        traversalCounterKey(projection.activations["act-start"], {
          ...sealed.edges[0],
          id: 1n as unknown as string,
        }),
      "invalid_input",
    );
  });
});
