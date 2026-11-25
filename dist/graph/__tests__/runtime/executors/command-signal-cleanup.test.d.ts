/**
 * Graph run signal cleanup (OMC_GRAPH_SIGNAL_CLEANUP=1).
 *
 * The cleanup keeps module-level state (`interrupted`, the active-child set),
 * so every test loads a fresh copy of the command executor module and removes
 * the SIGINT/SIGTERM listeners it installed. `process.exit` is mocked: the
 * handler is exercised in-process with `process.emit`, never with a real
 * signal sent to the test worker. The only real processes are short `node`
 * children standing in for a running graph node.
 */
export {};
//# sourceMappingURL=command-signal-cleanup.test.d.ts.map