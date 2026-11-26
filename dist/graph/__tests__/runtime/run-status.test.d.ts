/**
 * Tests for `omc graph status <run_id>` (read-only derived state of one graph run).
 *
 * The runs are real: a two-step chain of command nodes is run through runGraph, and
 * the interrupted run is stopped by aborting the runner signal right after step 1
 * commits, so step 2 is left ready. The CLI cases go through the real `graph status`
 * command and read the JSON it prints.
 */
export {};
//# sourceMappingURL=run-status.test.d.ts.map