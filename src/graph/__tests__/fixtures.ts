/**
 * Contract-authored Graph Core test fixtures.
 *
 * Authored from spec `deep-interview-issue-3570-graph-core.md` and the ralplan
 * stage-04 revision (`pending-approval.md`); oracle `99ffe31` used only for
 * behavioral cross-checks in the scratch harness; no reference fixture
 * structure copied.
 */

import type {
  GraphAgentNode,
  GraphCommandNode,
  GraphDescriptorInput,
} from "../types.js";

/** Minimal valid executable (agent/command) node. */
export function executableNode(
  id: string,
  kind: "agent" | "command",
): GraphAgentNode | GraphCommandNode {
  const title = `Node ${id}`;
  if (kind === "agent") {
    return {
      id,
      kind,
      title,
      timeout_ms: 60_000,
      max_attempts: 3,
      effect_policy: { policy: "side_effect_free" },
      instructions: `Instructions for ${id}`,
    };
  }
  return {
    id,
    kind,
    title,
    timeout_ms: 60_000,
    max_attempts: 3,
    effect_policy: { policy: "side_effect_free" },
    command: `echo ${id}`,
  };
}

/** Fan-out → two branches → join → terminal verification. */
export function forkJoinDescriptor(): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-fork-join",
    revision_id: "rev-fork-join",
    goal: "Verify fork/join orchestration",
    nodes: [
      {
        ...executableNode("fan", "agent"),
        title: "Fan out",
      },
      {
        ...executableNode("b1", "agent"),
        title: "Branch one",
      },
      {
        ...executableNode("b2", "command"),
        title: "Branch two",
      },
      {
        id: "join",
        kind: "join",
        title: "Join",
        fan_out_node_id: "fan",
        input_branch_ids: ["br1", "br2"],
      },
      {
        ...executableNode("term", "command"),
        title: "Terminal",
      },
    ],
    edges: [
      {
        id: "e-fan-b1",
        kind: "fan_out",
        from: "fan",
        to: "b1",
        branch_id: "br1",
        owner_join_id: "join",
      },
      {
        id: "e-fan-b2",
        kind: "fan_out",
        from: "fan",
        to: "b2",
        branch_id: "br2",
        owner_join_id: "join",
      },
      { id: "e-b1-join", kind: "fixed", from: "b1", to: "join" },
      { id: "e-b2-join", kind: "fixed", from: "b2", to: "join" },
      { id: "e-join-term", kind: "fixed", from: "join", to: "term" },
    ],
    entry_node_ids: ["fan"],
    concurrency_limit: 2,
    terminal_verification_node_id: "term",
  };
}

/**
 * Bounded retry loop: `work` retries itself via a back edge while a forward
 * `give-up` exit keeps the loop node from being back-edge-only.
 */
export function loopDescriptor(): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-loop",
    revision_id: "rev-loop",
    goal: "Verify bounded retry loop",
    nodes: [
      {
        ...executableNode("start", "agent"),
        title: "Start",
      },
      {
        ...executableNode("work", "command"),
        title: "Work",
      },
      {
        ...executableNode("give_up", "command"),
        title: "Give up",
      },
      {
        ...executableNode("term", "command"),
        title: "Terminal",
      },
    ],
    edges: [
      { id: "e-start-work", kind: "fixed", from: "start", to: "work" },
      {
        id: "e-work-retry",
        kind: "back_edge",
        from: "work",
        to: "work",
        route: "retry",
        max_traversals: 3,
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

/** Entry → human-approval → single fixed edge → terminal verification. */
export function approvalDescriptor(): GraphDescriptorInput {
  return {
    descriptor_version: 1,
    run_id: "run-approval",
    revision_id: "rev-approval",
    goal: "Verify human approval gate",
    nodes: [
      {
        ...executableNode("entry", "agent"),
        title: "Entry",
      },
      {
        id: "approval",
        kind: "human-approval",
        title: "Approve release",
        prompt: "Approve the release?",
      },
      {
        ...executableNode("term", "command"),
        title: "Terminal",
      },
    ],
    edges: [
      { id: "e-entry-approval", kind: "fixed", from: "entry", to: "approval" },
      { id: "e-approval-term", kind: "fixed", from: "approval", to: "term" },
    ],
    entry_node_ids: ["entry"],
    concurrency_limit: 1,
    terminal_verification_node_id: "term",
  };
}
