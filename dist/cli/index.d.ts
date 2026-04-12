#!/usr/bin/env node
/**
 * Oh-My-ClaudeCode CLI
 *
 * Command-line interface for the OMC multi-agent system.
 *
 * Commands:
 * - run: Start an interactive session
 * - config: Show or edit configuration
 * - setup: Sync all OMC components (hooks, agents, skills)
 */
import { Command } from 'commander';
import { type StandaloneDuplicatesPreview } from '../installer/index.js';
/**
 * Apply a --plugin-dir option value: resolve to absolute path, warn if it
 * disagrees with a pre-existing OMC_PLUGIN_ROOT env var, then set the env var
 * so all subsequent code in this process sees the correct plugin root.
 *
 * No-op when `rawPath` is undefined/empty (option was not passed).
 */
export declare function applyPluginDirOption(rawPath: string | undefined): void;
/**
 * Setup command - Official CLI entry point for omc-setup
 *
 * User-friendly command that syncs all OMC components:
 * - Installs/updates hooks, agents, and skills
 * - Reconciles runtime state after updates
 * - Shows clear summary of what was installed/updated
 */
/**
 * Emit a one-shot stderr advisory for `--skip-hooks` (non-regression #2).
 *
 * The flag now actually skips hook installation (previously a no-op),
 * so we warn scripts that silently relied on the old behavior. Suppressed
 * on repeat invocations via a daily sentinel under
 * `$XDG_STATE_HOME/omc/` (fallback: `$HOME/.omc/state/`) — don't spam
 * `omc setup --skip-hooks` in a tight loop.
 */
export declare function emitSkipHooksAdvisory(stderr?: NodeJS.WritableStream): void;
/**
 * `--build-preset` internal subcommand implementation.
 *
 * Reads `--answers <file>` as JSON, runs `buildPreset()` to produce a
 * validated `SetupOptions`, serializes to JSON, and writes to `--out`.
 * Exit 0 on success, non-zero on invalid answers / IO errors.
 *
 * This mirrors the skill's contract: skill collects answers → writes
 * JSON to tmp file → invokes `omc setup --build-preset` → invokes
 * `omc setup --preset <out>`. All decision logic lives in the pure
 * `buildPreset()` function which is exhaustively unit-tested.
 */
export declare function runBuildPreset(answersPath: string, outPath: string, stderr?: NodeJS.WritableStream): number;
/**
 * Run the plugin-duplicate leftover cleanup flow. Safe to call
 * unconditionally — it's a no-op when no plugin is active OR no
 * leftovers exist.
 *
 * Behavior:
 *   - TTY + hasWork → render preview, prompt Y/n, execute on confirm
 *   - non-TTY + hasWork → silent auto-prune, log summary
 *   - hasWork === false → immediate return (no preview, no prompt)
 *
 * Returns the final `StandaloneDuplicatesPreview` — either the
 * execute result (on TTY confirm or non-TTY auto-prune) or the
 * preview result (on TTY decline). Caller can inspect `hasWork`
 * + per-kind arrays if downstream code needs to know what was
 * touched.
 */
export declare function runLeftoverCleanupFlow(opts: {
    isTty: boolean;
    stdout: NodeJS.WritableStream;
}): Promise<StandaloneDuplicatesPreview>;
export declare function runSetupCommand(commanderOpts: Record<string, unknown>, stderr?: NodeJS.WritableStream): Promise<number>;
/**
 * Returns the fully-configured commander program.
 *
 * Exported so tests can drive the real CLI pipeline (e.g.
 * `await buildProgram().parseAsync(['node','omc','setup','--plugin-dir-mode'], { from: 'user' })`)
 * without spawning a subprocess. The program is built once at module load
 * (commander does not support re-registration), so this just returns the
 * singleton.
 */
export declare function buildProgram(): Command;
//# sourceMappingURL=index.d.ts.map