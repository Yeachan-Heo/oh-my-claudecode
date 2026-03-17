/**
 * Deepinit Manifest Tool
 *
 * Deterministic, code-level manifest system for incremental /deepinit.
 * Tracks directory file lists so subsequent runs only regenerate AGENTS.md
 * for directories whose structure has actually changed.
 *
 * Actions:
 * - diff: Compare current filesystem to saved manifest
 * - save: Write current filesystem state as manifest
 * - check: Return whether manifest exists and is valid
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1719
 */

import { z } from 'zod';
import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { validateWorkingDirectory, getOmcRoot } from '../lib/worktree-paths.js';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { TOOL_CATEGORIES } from '../constants/names.js';
import type { ToolDefinition } from './types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const MANIFEST_VERSION = 1;

/** Maximum recursion depth to prevent stack overflow */
const MAX_DEPTH = 50;

/** Maximum directories to scan to prevent memory exhaustion */
const MAX_DIRECTORIES = 10_000;

/** Directories excluded by name (exact match) */
const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', '__pycache__',
  'coverage', '.next', '.nuxt',
]);

// =============================================================================
// TYPES
// =============================================================================

/** Sorted file list for a single directory */
interface DirectoryEntry {
  readonly files: readonly string[];
}

/** The persisted manifest structure */
interface DeepInitManifest {
  readonly version: 1;
  readonly generatedAt: string;
  readonly directories: Readonly<Record<string, DirectoryEntry>>;
}

/** Change status for a directory */
type ChangeStatus = 'added' | 'deleted' | 'modified' | 'unchanged';

/** Diff result for a single directory */
interface DiffEntry {
  readonly path: string;
  readonly status: ChangeStatus;
  readonly reason?: string;
}

/** Full diff result */
interface DiffResult {
  readonly entries: readonly DiffEntry[];
  readonly summary: {
    readonly total: number;
    readonly added: number;
    readonly deleted: number;
    readonly modified: number;
    readonly unchanged: number;
  };
}

// =============================================================================
// SCHEMA
// =============================================================================

const deepinitManifestSchema = {
  action: z.enum(['diff', 'save', 'check']).describe(
    'Action: diff (compare current filesystem to saved manifest — compares directory file lists, not file contents), ' +
    'save (write current filesystem state as manifest), ' +
    'check (return whether manifest exists and is valid)'
  ),
  workingDirectory: z.string().optional().describe(
    'Project root directory. Auto-detected from git worktree if omitted.'
  ),
  mode: z.enum(['incremental', 'full']).optional().default('incremental').describe(
    'Only valid with action=diff. incremental (default) returns only changed dirs, full returns all dirs as added.'
  ),
  dryRun: z.boolean().optional().default(false).describe(
    'Only valid with action=save. If true, return what would be saved without writing.'
  ),
};

type DeepinitManifestInput = z.infer<z.ZodObject<typeof deepinitManifestSchema>>;

// =============================================================================
// CORE FUNCTIONS (exported for testing)
// =============================================================================

/**
 * Returns true if a directory name should be excluded from scanning.
 * Excludes all hidden directories (starting with '.') and known build/dependency dirs.
 */
export function isExcluded(name: string): boolean {
  return name.startsWith('.') || EXCLUDED_DIRS.has(name);
}

/**
 * Recursively scan a project directory and build a record of directory → file list.
 * - Skips excluded directories via isExcluded()
 * - Skips empty directories (no files)
 * - Uses inode tracking to prevent symlink loops
 * - File lists are sorted alphabetically for deterministic comparison
 * - All paths use '/' separator regardless of platform
 *
 * @param projectRoot Absolute path to the project root
 * @returns Record keyed by relative path ('.' for root), value is DirectoryEntry
 */
export function scanDirectories(projectRoot: string): Record<string, DirectoryEntry> {
  const result: Record<string, DirectoryEntry> = {};
  const visitedInodes = new Set<number>();

  // Resolve the real project root for symlink containment checks
  let realProjectRoot: string;
  try {
    realProjectRoot = realpathSync(projectRoot);
  } catch {
    realProjectRoot = projectRoot;
  }

  let dirCount = 0;

  function walk(absDir: string, depth: number): void {
    // Guard against excessive depth or directory count
    if (depth > MAX_DEPTH || dirCount > MAX_DIRECTORIES) return;

    // Symlink containment: verify resolved path is under project root
    try {
      const realDir = realpathSync(absDir);
      if (realDir !== realProjectRoot && !realDir.startsWith(realProjectRoot + sep)) {
        return; // Symlink escapes project root — skip
      }
    } catch {
      return; // Skip inaccessible directories
    }

    // Symlink loop protection via inode tracking
    try {
      const stat = statSync(absDir);
      if (visitedInodes.has(stat.ino)) return;
      visitedInodes.add(stat.ino);
    } catch {
      return; // Skip inaccessible directories
    }

    dirCount++;

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    const files: string[] = [];
    const subdirs: string[] = [];

    for (const entry of entries) {
      // Skip symbolic links to prevent escape and information disclosure
      if (entry.isSymbolicLink()) continue;

      if (entry.isFile()) {
        files.push(entry.name);
      } else if (entry.isDirectory() && !isExcluded(entry.name)) {
        subdirs.push(entry.name);
      }
    }

    // Only track directories that contain files
    if (files.length > 0) {
      const relPath = relative(projectRoot, absDir).split(sep).join('/') || '.';
      result[relPath] = { files: [...files].sort() };
    }

    // Recurse into subdirectories
    for (const sub of subdirs) {
      walk(join(absDir, sub), depth + 1);
    }
  }

  walk(projectRoot, 0);
  return result;
}

/**
 * Load and parse a manifest file.
 * Returns null if file doesn't exist, is unreadable, fails JSON parse,
 * or has an incompatible version.
 */
export function loadManifest(manifestPath: string): DeepInitManifest | null {
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed.version !== MANIFEST_VERSION) return null;
    if (typeof parsed.directories !== 'object' || parsed.directories === null) return null;

    return parsed as unknown as DeepInitManifest;
  } catch {
    return null;
  }
}

/**
 * Compute the diff between a previous manifest state and the current directory tree.
 * - If previous is null, all current directories are 'added' (first run)
 * - Applies ancestor cascading: when a child is added/deleted, all ancestor
 *   directories are marked 'modified' (to update their Subdirectories table)
 *
 * @param previous Previous directory state (null = first run)
 * @param current Current directory state from scanDirectories()
 * @returns DiffResult with entries sorted by path
 */
export function computeDiff(
  previous: Readonly<Record<string, DirectoryEntry>> | null,
  current: Readonly<Record<string, DirectoryEntry>>,
): DiffResult {
  const entries = new Map<string, DiffEntry>();

  if (previous === null) {
    // First run: everything is added
    for (const path of Object.keys(current)) {
      entries.set(path, { path, status: 'added', reason: 'first run (no manifest)' });
    }
  } else {
    // Check current directories against previous
    for (const [path, entry] of Object.entries(current)) {
      const prev = previous[path];
      if (!prev) {
        entries.set(path, { path, status: 'added', reason: 'new directory' });
      } else {
        const prevFiles = [...prev.files].sort();
        const currFiles = [...entry.files].sort();

        if (prevFiles.length !== currFiles.length || prevFiles.some((f, i) => f !== currFiles[i])) {
          // Compute what changed using Set for O(n+m) instead of O(n*m)
          const prevSet = new Set(prevFiles);
          const currSet = new Set(currFiles);
          const added = currFiles.filter(f => !prevSet.has(f));
          const removed = prevFiles.filter(f => !currSet.has(f));
          const parts: string[] = [];
          if (added.length > 0) parts.push(`files added: ${added.join(', ')}`);
          if (removed.length > 0) parts.push(`files removed: ${removed.join(', ')}`);
          entries.set(path, { path, status: 'modified', reason: parts.join('; ') });
        } else {
          entries.set(path, { path, status: 'unchanged' });
        }
      }
    }

    // Check for deleted directories
    for (const path of Object.keys(previous)) {
      if (!(path in current)) {
        entries.set(path, { path, status: 'deleted', reason: 'directory no longer exists' });
      }
    }
  }

  // Ancestor cascading: mark parents of added/deleted dirs as modified
  const cascadeTargets = [...entries.values()]
    .filter(e => e.status === 'added' || e.status === 'deleted');

  for (const target of cascadeTargets) {
    const parts = target.path.split('/');
    // Walk up from parent to root
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join('/');
      const existing = entries.get(ancestor);
      if (existing && existing.status === 'unchanged') {
        entries.set(ancestor, {
          path: ancestor,
          status: 'modified',
          reason: `child directory ${target.status}: ${target.path}`,
        });
      }
    }
    // Handle root directory ('.')
    if (target.path !== '.') {
      const rootEntry = entries.get('.');
      if (rootEntry && rootEntry.status === 'unchanged') {
        entries.set('.', {
          path: '.',
          status: 'modified',
          reason: `child directory ${target.status}: ${target.path}`,
        });
      }
    }
  }

  // Sort by path and build result
  const sorted = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  const summary = {
    total: sorted.length,
    added: sorted.filter(e => e.status === 'added').length,
    deleted: sorted.filter(e => e.status === 'deleted').length,
    modified: sorted.filter(e => e.status === 'modified').length,
    unchanged: sorted.filter(e => e.status === 'unchanged').length,
  };

  return { entries: sorted, summary };
}

// =============================================================================
// ACTION HANDLERS
// =============================================================================

function resolveManifestPath(root: string): string {
  return join(getOmcRoot(root), 'deepinit-manifest.json');
}

function handleDiff(root: string, mode: string): { content: Array<{ type: 'text'; text: string }> } {
  const current = scanDirectories(root);
  const manifestPath = resolveManifestPath(root);

  let diff: DiffResult;
  if (mode === 'full') {
    // Full mode: treat everything as added
    diff = computeDiff(null, current);
  } else {
    const manifest = loadManifest(manifestPath);
    diff = computeDiff(manifest?.directories ?? null, current);
  }

  const output = {
    mode,
    manifestExists: existsSync(manifestPath),
    ...diff,
  };

  return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
}

function handleSave(root: string, dryRun: boolean): { content: Array<{ type: 'text'; text: string }> } {
  const current = scanDirectories(root);
  const manifest: DeepInitManifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    directories: current,
  };

  if (dryRun) {
    return {
      content: [{
        type: 'text' as const,
        text: `Dry run — manifest NOT written.\n\nDirectories tracked: ${Object.keys(current).length}\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``,
      }],
    };
  }

  const manifestPath = resolveManifestPath(root);
  atomicWriteJsonSync(manifestPath, manifest);

  return {
    content: [{
      type: 'text' as const,
      text: `Manifest saved successfully.\n\nPath: ${manifestPath}\nDirectories tracked: ${Object.keys(current).length}\nGenerated at: ${manifest.generatedAt}`,
    }],
  };
}

function handleCheck(root: string): { content: Array<{ type: 'text'; text: string }> } {
  const manifestPath = resolveManifestPath(root);
  const exists = existsSync(manifestPath);

  if (!exists) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ exists: false, valid: false, directoryCount: 0, generatedAt: null }, null, 2),
      }],
    };
  }

  const manifest = loadManifest(manifestPath);
  const valid = manifest !== null;
  const directoryCount = valid ? Object.keys(manifest!.directories).length : 0;
  const generatedAt = valid ? manifest!.generatedAt : null;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ exists, valid, directoryCount, generatedAt }, null, 2),
    }],
  };
}

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const deepinitManifestTool: ToolDefinition<typeof deepinitManifestSchema> = {
  name: 'deepinit_manifest',
  description:
    'Manage the deepinit manifest for incremental AGENTS.md regeneration. ' +
    'Compares directory file lists (not file contents) to detect structural changes. ' +
    'Actions: diff (find changed directories), save (persist current state), check (validate manifest).',
  category: TOOL_CATEGORIES.DEEPINIT,
  schema: deepinitManifestSchema,
  handler: async (args: DeepinitManifestInput) => {
    const { action, workingDirectory, mode, dryRun } = args;

    // Per-action parameter validation
    if (action !== 'diff' && mode !== undefined && mode !== 'incremental') {
      return {
        content: [{ type: 'text' as const, text: `Error: 'mode' parameter is only valid with action='diff'. Got action='${action}'.` }],
        isError: true,
      };
    }
    if (action !== 'save' && dryRun) {
      return {
        content: [{ type: 'text' as const, text: `Error: 'dryRun' parameter is only valid with action='save'. Got action='${action}'.` }],
        isError: true,
      };
    }

    try {
      const root = validateWorkingDirectory(workingDirectory);

      switch (action) {
        case 'diff':
          return handleDiff(root, mode ?? 'incremental');
        case 'save':
          return handleSave(root, dryRun ?? false);
        case 'check':
          return handleCheck(root);
        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown action: ${action}` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error in deepinit_manifest (${action}): ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  },
};
