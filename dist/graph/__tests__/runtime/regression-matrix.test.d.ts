/**
 * Regression matrix tests (AC-9/10/11/11b) — runner level with fake executors.
 *
 * AC-9  max_attempts: an always-failing executor terminal-fails the node
 *       after exactly its descriptor budget; no infinite retry.
 * AC-10 no-wedge: one branch failing terminally still drains sibling work and
 *       reaches a defined end state with an empty ready set.
 * AC-11 traversal round-trip: a bounded back-edge loop runs to terminal and
 *       an in-process journal replay-fold reproduces the live projection
 *       bit-for-bit under canonicalJson equality.
 * AC-11b tamper: flipping a journaled transition outcome makes the resume
 *       fold fail closed (CORRUPT_JOURNAL) without executing any node.
 */
export {};
//# sourceMappingURL=regression-matrix.test.d.ts.map