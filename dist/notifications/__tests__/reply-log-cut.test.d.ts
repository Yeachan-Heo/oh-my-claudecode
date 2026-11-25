/**
 * The reply that a failed command typed into a pane stands in the message of its error, cut at maxMessageLength.
 * A key that runs over the cut is only a fragment there, too short to be recognized, so the log must show the
 * reply redacted as a whole and cut afterwards, on every path that logs such a message (tmux send-keys, a .cmd
 * wrapper around tmux, the command line and the stderr of a failed Herdr prompt).
 */
export {};
//# sourceMappingURL=reply-log-cut.test.d.ts.map