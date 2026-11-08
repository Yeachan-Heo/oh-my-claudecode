/**
 * Tests for omc update --force-hooks protection (issue #722)
 *
 * Verifies that the hook merge logic in install() correctly:
 *   - merges OMC hooks with existing non-OMC hooks during `omc update` (force=true)
 *   - warns when non-OMC hooks are present
 *   - only fully replaces when --force-hooks is explicitly set
 *
 * Tests exercise isOmcHook() and the merge logic via unit-level helpers
 * to avoid filesystem side-effects.
 */
export {};
//# sourceMappingURL=installer-hooks-merge.test.d.ts.map