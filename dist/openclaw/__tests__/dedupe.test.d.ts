/**
 * Unit tests for the openclaw dedupe module.
 *
 * Covers the terminal-state freshness suppression added for issue #2553:
 * late session-start / stop (idle) events fired after a session has already
 * reached a terminal state must be silently dropped so already-completed or
 * already-cleaned-up sessions do not emit follow-up lifecycle noise.
 */
export {};
//# sourceMappingURL=dedupe.test.d.ts.map