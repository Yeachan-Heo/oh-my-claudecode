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
/**
 * Apply a --plugin-dir option value: resolve to absolute path, warn if it
 * disagrees with a pre-existing OMC_PLUGIN_ROOT env var, then set the env var
 * so all subsequent code in this process sees the correct plugin root.
 *
 * No-op when `rawPath` is undefined/empty (option was not passed).
 */
export declare function applyPluginDirOption(rawPath: string | undefined): void;
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