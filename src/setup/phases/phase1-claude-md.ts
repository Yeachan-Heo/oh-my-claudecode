/**
 * Phase 1 glue — CLAUDE.md install / merge.
 *
 * Thin wrapper around `installClaudeMd()` from `../claude-md.js`. Derives
 * `mode` and `installStyle` from the resolved SetupOptions, calls the
 * ported installer, and returns the subset of its result that phase 4
 * needs for the welcome message display.
 *
 * Pure function: no module-level side effects. All stdout goes through
 * the injected logger; errors propagate via throw.
 *
 * Plan reference: "Phase 2 / 3 / 4 glue" in replicated-mixing-wren.md.
 */

import {
  installClaudeMd,
  type InstallClaudeMdOptions,
  type InstallClaudeMdResult,
} from '../claude-md.js';
import type { SetupOptions } from '../options.js';

export type Logger = (line: string) => void;

/**
 * Subset of `InstallClaudeMdResult` that downstream phases (notably
 * phase 4's welcome message) care about. Kept minimal on purpose —
 * runSetup is free to widen this later, but phases must never depend
 * on fields they don't use.
 */
export interface Phase1Result {
  mode: 'local' | 'global';
  installStyle: 'overwrite' | 'preserve';
  targetPath: string;
  backupPath: string | null;
  oldVersion: string;
  newVersion: string;
}

export interface Phase1Deps {
  /** Test seam: replace `installClaudeMd` with a stub. */
  installClaudeMd?: (opts: InstallClaudeMdOptions) => Promise<InstallClaudeMdResult>;
  /** Forwarded to `installClaudeMd` (test-only override of config root). */
  configDir?: string;
  /** Forwarded to `installClaudeMd` (test-only cwd override). */
  cwd?: string;
  /** Forwarded to `installClaudeMd` (test-only plugin root override). */
  pluginRoot?: string;
  /** Forwarded to `installClaudeMd` (test-only fetch override). */
  fetchImpl?: typeof fetch;
}

/**
 * Run Phase 1 — install or merge CLAUDE.md.
 *
 * Throws on any install failure (invalid mode, corrupted source, symlink
 * target, etc.) — the caller (`runSetup`) is responsible for surfacing
 * the error and deciding whether to continue to Phase 2.
 */
export async function runPhase1(
  options: SetupOptions,
  logger: Logger,
  deps: Phase1Deps = {},
): Promise<Phase1Result> {
  const installFn = deps.installClaudeMd ?? installClaudeMd;

  const result = await installFn({
    mode: options.target,
    installStyle: options.installStyle,
    logger,
    configDir: deps.configDir,
    cwd: deps.cwd,
    pluginRoot: deps.pluginRoot,
    fetchImpl: deps.fetchImpl,
  });

  return {
    mode: result.mode,
    installStyle: result.installStyle,
    targetPath: result.targetPath,
    backupPath: result.backupPath,
    oldVersion: result.oldVersion,
    newVersion: result.newVersion,
  };
}
