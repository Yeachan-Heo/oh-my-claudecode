/**
 * Tests for the plugin-path SessionEnd bootstrap chain wiring (defect: plugin
 * installs register hooks/hooks.json → scripts/session-end.mjs →
 * publishSessionEndBootstrap, which is the ONLY SessionEnd entry when plugin
 * hooks are enabled — the standalone settings.json forwarder is skipped).
 * The bootstrap must therefore plan the chain enqueue and merge it into the
 * durable manifest payload exactly like processSessionEnd does.
 */
export {};
//# sourceMappingURL=foreground-bootstrap.test.d.ts.map