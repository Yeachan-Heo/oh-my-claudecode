/**
 * Tests for stale data handling in usage API.
 *
 * - 429 responses should set stale: true on returned UsageResult
 * - lastSuccessAt tracks when data was last successfully fetched
 * - After 15 minutes from lastSuccessAt, stale data is discarded
 */
export {};
//# sourceMappingURL=usage-api-stale.test.d.ts.map