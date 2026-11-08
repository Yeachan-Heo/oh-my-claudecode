/**
 * Checkpoint command - Workspace snapshot/rollback for autonomous runs.
 *
 * Thin CLI adapter only: all snapshot logic lives in
 * src/features/checkpoint/index.ts.
 */
import { Command } from 'commander';
/**
 * Returns the `checkpoint` command:
 *
 *   omc checkpoint create [--label <text>]
 *   omc checkpoint list
 *   omc checkpoint rollback <id> [--force]
 */
export declare function checkpointCommand(): Command;
//# sourceMappingURL=checkpoint.d.ts.map