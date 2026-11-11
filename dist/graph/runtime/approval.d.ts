/**
 * Human approval gate (graph runtime v2).
 *
 * Bridges the frozen HumanApprovalPrompter contract to a stdin/stdout y/n
 * prompt. Fail-closed by construction: stream EOF/closure, unrecognized
 * input after the single re-prompt, or any non-yes/no answer resolves to
 * "denied" (AC-14 / AC-14b: denied is a first-class recorded outcome).
 */
import type { GraphApprovalDecision } from "../types.js";
import type { HumanApprovalPrompter } from "./types.js";
type Decision = GraphApprovalDecision["decision"];
/**
 * A prompter that always returns the given decision without touching any
 * stream. Used by runner unit tests and non-interactive invocations.
 */
export declare function createFixedApprovalGate(decision: Decision): HumanApprovalPrompter;
/**
 * Interactive y/n gate over an injectable readable stream (default
 * process.stdin). Prompts via process.stdout.write only — never console.
 */
export declare function createStdinApprovalGate(input?: NodeJS.ReadableStream): HumanApprovalPrompter;
export {};
//# sourceMappingURL=approval.d.ts.map