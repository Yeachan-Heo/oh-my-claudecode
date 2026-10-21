/**
 * The wiki SessionEnd producer runs inside run.cjs's fixed 300ms foreground
 * budget and is terminated (fail-open) when it overruns. The durable guarantee
 * is ordering: the capture intent is sealed before the worker module is
 * loaded, so a termination during the worker import/spawn cannot lose it — a
 * later worker pass still commits the session-log page.
 */
export {};
//# sourceMappingURL=wiki-foreground-bootstrap.test.d.ts.map