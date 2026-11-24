/**
 * P1-4 journal epoch provenance regression tests.
 *
 * A committed record's epoch must be semantically bound at resume-fold:
 * - forged future epochs (currentEpoch+N) fail closed CORRUPT_JOURNAL(20)
 *   without executing any node (maintainer probe reproduction);
 * - legitimately increasing epochs across takeovers (1 then 2) fold fine.
 */
export {};
//# sourceMappingURL=journal-epoch.test.d.ts.map