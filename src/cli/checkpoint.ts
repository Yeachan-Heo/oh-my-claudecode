/**
 * Checkpoint command - Workspace snapshot/rollback for autonomous runs.
 *
 * Thin CLI adapter only: all snapshot logic lives in
 * src/features/checkpoint/index.ts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  CheckpointError,
  createCheckpoint,
  isWorktreeDirty,
  listCheckpoints,
  rollbackToCheckpoint,
} from '../features/checkpoint/index.js';

function errorMessage(error: unknown): string {
  if (error instanceof CheckpointError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string, code: number): void {
  console.error(chalk.red(`Error: ${message}`));
  process.exitCode = code;
}

/**
 * Returns the `checkpoint` command:
 *
 *   omc checkpoint create [--label <text>]
 *   omc checkpoint list
 *   omc checkpoint rollback <id> [--force]
 */
export function checkpointCommand(): Command {
  const command = new Command('checkpoint');
  command.description('Snapshot and restore the working tree (git shadow commits)');

  command
    .command('create')
    .description('Snapshot the working tree (tracked, modified, and untracked files)')
    .option('--label <text>', 'Human-readable label', 'manual')
    .action((options: { label: string }) => {
      try {
        const id = createCheckpoint(process.cwd(), options.label);
        console.log(
          `Checkpoint ${chalk.bold(id)} created${options.label ? ` (${options.label})` : ''}.`,
        );
        console.log(`Restore with: omc checkpoint rollback ${id}`);
      } catch (error) {
        fail(errorMessage(error), error instanceof CheckpointError ? error.exitCode : 1);
      }
    });

  command
    .command('list')
    .description('List checkpoints (oldest first)')
    .action(() => {
      try {
        const entries = listCheckpoints(process.cwd());
        if (entries.length === 0) {
          console.log('No checkpoints.');
          return;
        }
        for (const entry of entries) {
          console.log(`${chalk.bold(entry.id)}  ${entry.createdAt}  ${entry.label}`);
        }
      } catch (error) {
        fail(errorMessage(error), error instanceof CheckpointError ? error.exitCode : 1);
      }
    });

  command
    .command('rollback <id>')
    .description('Restore the working tree from a checkpoint (discards later changes)')
    .option('--force', 'Required when the working tree has uncommitted changes', false)
    .action((id: string, options: { force: boolean }) => {
      try {
        const dirty = isWorktreeDirty(process.cwd());
        rollbackToCheckpoint(process.cwd(), id, options.force);
        console.log(
          dirty
            ? `Rolled back to ${chalk.bold(id)} (uncommitted changes were discarded).`
            : `Rolled back to ${chalk.bold(id)}.`,
        );
      } catch (error) {
        fail(errorMessage(error), error instanceof CheckpointError ? error.exitCode : 1);
      }
    });

  return command;
}
