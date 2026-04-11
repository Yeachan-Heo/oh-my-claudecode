/**
 * Shared test helpers for src/setup/__tests__/*.test.ts.
 *
 * Extracted from phase1-claude-md, phase2-configure, phase3-integrations, and
 * phase4-welcome tests which all contained identical makeOptions() copies.
 */

import { DEFAULTS } from '../options.js';
import type { SetupOptions } from '../options.js';

/**
 * Build a fully-valid SetupOptions from DEFAULTS with selective overrides.
 * Ensures required nested objects (mcp, teams, installerOptions) are always
 * present so phase modules receive well-formed input.
 */
export function makeOptions(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    ...DEFAULTS,
    phases: new Set(DEFAULTS.phases),
    mcp: { ...DEFAULTS.mcp, credentials: {}, servers: [] },
    teams: { ...DEFAULTS.teams },
    installerOptions: {},
    ...overrides,
  };
}
