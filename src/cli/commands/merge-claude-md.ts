/**
 * Internal CLI entry: merge OMC content into a CLAUDE.md file using the shared,
 * cleanup-capable {@link mergeClaudeMd}. `scripts/setup-claude-md.sh` invokes
 * this so the shell setup path and the TypeScript installer share one merge
 * implementation (including legacy pre-marker guide removal).
 *
 * Usage:
 *   node dist/cli/commands/merge-claude-md.js --target <path> --source <path> [--version <v>]
 *
 * Reads the existing target (if present) and the canonical OMC source, writes the
 * merged result back to target, and exits non-zero on error so the caller can
 * fail safe instead of writing a half-merged file.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mergeClaudeMd } from '../../installer/claude-md-merge.js';

interface MergeArgs {
  target?: string;
  source?: string;
  version?: string;
}

export function parseMergeArgs(argv: string[]): MergeArgs {
  const args: MergeArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--target') {
      args.target = value;
      i += 1;
    } else if (flag === '--source') {
      args.source = value;
      i += 1;
    } else if (flag === '--version') {
      args.version = value;
      i += 1;
    }
  }
  return args;
}

/** Perform the merge; returns the path written. Throws on invalid input. */
export function runMergeClaudeMd(args: MergeArgs): string {
  if (!args.target || !args.source) {
    throw new Error('merge-claude-md requires --target <path> and --source <path>');
  }
  if (!existsSync(args.source)) {
    throw new Error(`merge-claude-md source not found: ${args.source}`);
  }

  const existingContent = existsSync(args.target) ? readFileSync(args.target, 'utf-8') : null;
  const omcContent = readFileSync(args.source, 'utf-8');
  const merged = mergeClaudeMd(existingContent, omcContent, args.version);
  writeFileSync(args.target, merged);
  return args.target;
}

function main(): void {
  try {
    const args = parseMergeArgs(process.argv.slice(2));
    runMergeClaudeMd(args);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

// Run when invoked directly (not when imported by tests). Match the entry file
// by basename across build formats (.js/.cjs/.mjs) and the TS source.
const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
if (/\/merge-claude-md\.(?:js|cjs|mjs|ts)$/.test(invokedPath)) {
  main();
}
