/**
 * Shared reader for the OMC_DEBUG environment variable.
 *
 * The variable was read three incompatible ways. Most sites treat any non-empty
 * value as on. `hooks/todo-continuation` accepts '1', 'true' or its own scope name.
 * Two sites compared against a single literal -- 'true' in `features/delegation-enforcer`
 * and '1' in `hooks/learner/constants` -- so neither documented value turned both on:
 * `OMC_DEBUG=1` left the delegation enforcer silent even though
 * docs/DELEGATION-ENFORCER.md is the file that documents the flag, and
 * `OMC_DEBUG=true` left the learner silent.
 *
 * This reader follows the todo-continuation precedent, which is the only site that
 * already handled both spellings.
 */

/** Values that explicitly mean "off", so OMC_DEBUG=0 does not read as truthy. */
const DISABLED_VALUES = new Set(['', '0', 'false']);

/**
 * Whether OMC_DEBUG requests debug output, optionally for a named scope.
 *
 * Accepts '1' or 'true' (any case) for every scope, or a comma-separated list
 * containing `scope` to enable one area only. Unset, empty, '0' and 'false' are off.
 *
 * @param scope optional area name, matched against a comma-separated list
 * @returns true when debug output is requested
 */
export function isDebugEnabled(scope?: string): boolean {
  const raw = process.env.OMC_DEBUG;
  if (raw === undefined) return false;

  const value = raw.trim().toLowerCase();
  if (DISABLED_VALUES.has(value)) return false;
  if (value === '1' || value === 'true') return true;

  if (!scope) return false;
  const wanted = scope.trim().toLowerCase();
  return value.split(',').some((entry) => entry.trim() === wanted);
}
