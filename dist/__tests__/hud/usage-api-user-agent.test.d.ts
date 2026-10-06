/**
 * Tests for the User-Agent on `GET /api/oauth/usage`.
 *
 * The endpoint buckets its rate limit by User-Agent, and a request that does not
 * name a Claude Code *version* lands in a bucket that allows roughly one request
 * per hour. Measured against api.anthropic.com with a single OAuth token,
 * requests seconds apart, recording status and `retry-after` only:
 *
 *   User-Agent           | HTTP | retry-after
 *   ---------------------|------|--------------------------------------------
 *   (header omitted)     | 429  | 348s
 *   claude-code          | 429  | 349s / 348s - same absolute deadline
 *   claude-code/2.1.232  | 403  | none - the endpoint's real answer
 *   claude-code/9.9.9    | 403  | none - the endpoint's real answer
 *
 * The 403 is the token's own scope error, i.e. a real per-request answer rather
 * than a throttle. Two things follow, and both are asserted below: a versioned
 * product token is what unlocks the bucket, and a version-less one buys nothing,
 * so we send no header at all rather than a fabricated version.
 */
export {};
//# sourceMappingURL=usage-api-user-agent.test.d.ts.map