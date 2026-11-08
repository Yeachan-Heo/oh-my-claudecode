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
import type { GraphDescriptor, GraphDescriptorInput, SealedGraphDescriptor } from "./types.js";
export declare class GraphDescriptorValidationError extends Error {
    readonly issues: readonly string[];
    constructor(issues: readonly string[]);
}
/**
 * Serialize JSON values with object keys sorted recursively in lexical order.
 * Strict current-dev semantics: compact output, arrays in given order; throws
 * `TypeError` on `undefined`, non-finite numbers, symbols, functions, bigints,
 * non-plain objects (Date/Map/Set/RegExp/class instances), and cyclic values.
 */
export declare function canonicalJson(value: unknown): string;
/** Lowercase SHA-256 hex over the canonical compact JSON of the hash payload. */
export declare function computeDescriptorHash(input: GraphDescriptorInput): string;
/**
 * Structural validation. Throws `GraphDescriptorValidationError` with the
 * joined issue list; returns the descriptor unchanged on success.
 */
export declare function validateGraphDescriptor(descriptor: GraphDescriptor): GraphDescriptor;
/**
 * Draft parser: strict schema parse → full validation → defensive
 * `structuredClone` + `deepFreeze`. Input carrying a `descriptor_hash` is
 * rejected with a directed error (use `parseSealedGraphDescriptor`).
 */
export declare function parseGraphDescriptor(input: unknown): GraphDescriptor;
/**
 * Sole draft → scheduler producer: strict parse → validate → compute hash →
 * defensive `structuredClone` + `deepFreeze` with `descriptor_hash`. Input
 * carrying a `descriptor_hash` is rejected with a directed error.
 */
export declare function sealGraphDescriptor(input: unknown): SealedGraphDescriptor;
/**
 * Sole persisted → scheduler producer. Requires a well-formed `descriptor_hash`;
 * strict schema parse → full validation → recompute the hash and compare with
 * the supplied hash; a mismatch is rejected (never silently recomputed), then a
 * defensive `structuredClone` + `deepFreeze` is returned.
 */
export declare function parseSealedGraphDescriptor(input: unknown): SealedGraphDescriptor;
/**
 * Non-branding, never-throws boolean predicate. Structure-before-hash: strict
 * schema parse → full validation → hash recompute → compare; `false` on any
 * structural failure or mismatch. Does not clone, freeze, or mutate its input.
 */
export declare function verifyDescriptorHash(input: unknown): boolean;
/** Non-throwing structural check (shape parse + validation, no hash semantics). */
export declare function isGraphDescriptor(input: unknown): input is GraphDescriptor;
//# sourceMappingURL=descriptor.d.ts.map