/**
 * lookout command - pre-flight danger scan for autonomous runs.
 *
 * Thin CLI adapter only: all scanning logic lives in
 * src/features/lookout/index.ts. lookout is advisory by design: a scan
 * never blocks anything. Exit code contract (machine-readable, mirrors the
 * drydock follow-up wording):
 *   0 = scan ran, no high-severity findings (with or without --strict)
 *   1 = --strict and the verdict is review-recommended
 *   2 = usage or scan error
 */
import { Command } from 'commander';
/**
 * Returns the `lookout` command:
 *
 *   omc lookout scan [--brief <text|@file>] [--json] [--strict] [--repo <dir>]
 */
export declare function lookoutCommand(): Command;
//# sourceMappingURL=lookout.d.ts.map