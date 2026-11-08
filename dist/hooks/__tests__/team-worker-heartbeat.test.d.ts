/**
 * Regression test for: missing heartbeat file should return fresh:false
 *
 * Bug: readWorkerHeartbeatSnapshot returned fresh:true when the heartbeat file
 * didn't exist, causing false "all workers idle" notifications.
 *
 * Fix: VAL-SPLIT-001 — missing heartbeat must return fresh:false.
 */
export {};
//# sourceMappingURL=team-worker-heartbeat.test.d.ts.map