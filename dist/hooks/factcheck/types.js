/**
 * Factcheck Guard Types
 *
 * TypeScript types for the portable factcheck guard and sentinel health analyzer.
 * Ported from rolldav/portable-omc-guards (issue #1155).
 */
// ---------------------------------------------------------------------------
// Required fields / gates constants
// ---------------------------------------------------------------------------
export const REQUIRED_FIELDS = new Set([
    'schema_version',
    'run_id',
    'ts',
    'cwd',
    'mode',
    'files_modified',
    'files_created',
    'artifacts_expected',
    'gates',
]);
export const REQUIRED_GATES = new Set([
    'selftest_ran',
    'goldens_ran',
    'sentinel_stop_smoke_ran',
    'shadow_leak_check_ran',
]);
//# sourceMappingURL=types.js.map