/**
 * Tests for usage-api file lock (thundering herd prevention).
 *
 * When multiple sessions share the same cache file, only one session
 * should fetch from the API at a time. Others should return stale cache.
 */
export {};
//# sourceMappingURL=usage-api-lock.test.d.ts.map