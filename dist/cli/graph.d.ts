/**
 * Graph command - Execute sealed graph descriptors via graph runtime v2.
 *
 * Thin CLI adapter only: descriptor load/seal/resume-identity checks live
 * here; all execution logic lives in src/graph/runtime/.
 */
import { Command } from 'commander';
/**
 * Returns the `graph` command:
 *
 *   omc graph run <descriptorPath> [--runs-root <dir>]
 */
export declare function graphCommand(): Command;
//# sourceMappingURL=graph.d.ts.map