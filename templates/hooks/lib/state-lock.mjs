// Standalone hook template contract: installers MUST replace this file with a
// package-root-pinned bridge before copying hook entrypoints. Direct execution of
// an unprovisioned template fails closed rather than discovering dependencies.
throw new Error('Unprovisioned standalone state-lock template; run installer provisioning first');
