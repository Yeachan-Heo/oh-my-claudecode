/**
 * Functional Smoke Tests — Slack Socket Mode & State Cancel Cleanup
 *
 * Covers:
 *   1. SlackSocketClient — envelope parsing, message filtering, reconnect
 *      backoff, max-attempt enforcement, graceful shutdown, WS-unavailable
 *      fallback, and Slack API helper signatures (issues #1139)
 *   2. State tools — session-scoped write/read/clear cycle, cancel signal
 *      creation with TTL, ghost-legacy cleanup, broadcast clear, list_active
 *      with session scoping, and get_status details (issue #1143)
 */
export {};
//# sourceMappingURL=smoke-slack-and-state.test.d.ts.map