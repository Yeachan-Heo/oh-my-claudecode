/**
 * Contract-authored Graph Core test fixtures.
 *
 * Authored from spec `deep-interview-issue-3570-graph-core.md` and the ralplan
 * stage-04 revision (`pending-approval.md`); oracle `99ffe31` used only for
 * behavioral cross-checks in the scratch harness; no reference fixture
 * structure copied.
 */
import type { GraphAgentNode, GraphCommandNode, GraphDescriptorInput } from "../types.js";
/** Minimal valid executable (agent/command) node. */
export declare function executableNode(id: string, kind: "agent" | "command"): GraphAgentNode | GraphCommandNode;
/** Fan-out → two branches → join → terminal verification. */
export declare function forkJoinDescriptor(): GraphDescriptorInput;
/**
 * Bounded retry loop: `work` retries itself via a back edge while a forward
 * `give-up` exit keeps the loop node from being back-edge-only.
 */
export declare function loopDescriptor(): GraphDescriptorInput;
/** Entry → human-approval → single fixed edge → terminal verification. */
export declare function approvalDescriptor(): GraphDescriptorInput;
//# sourceMappingURL=fixtures.d.ts.map