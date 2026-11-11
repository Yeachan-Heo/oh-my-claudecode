/**
 * Daemon-level tests for the herdr arm of the rate-limit poll loop
 * (src/features/rate-limit-wait/daemon.ts).
 *
 * Drives the real pollLoop with the detector boundary mocked: a confirmed
 * limited -> clear transition must resume a tracked herdr pane through
 * sendHerdrResumeSequence while tmux panes keep using sendResumeSequence.
 */
export {};
//# sourceMappingURL=herdr-daemon.test.d.ts.map