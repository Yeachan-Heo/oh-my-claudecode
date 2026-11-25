/**
 * Graph run signal cleanup with real processes (OMC_GRAPH_SIGNAL_CLEANUP=1).
 *
 * Each case starts the real CLI (`omc graph run`) in a child process, interrupts it with a real
 * signal, and checks the exit code, the step processes left behind and the run state on disk.
 * A step is a `command` node that runs a small script: the script logs its start, records its pid,
 * optionally ignores SIGTERM, and blocks until its release file exists. Steps stand in for
 * long-running worker teams, which need tmux and a provider.
 */
export {};
//# sourceMappingURL=command-signal-process.test.d.ts.map