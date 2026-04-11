/**
 * Atomic JSON config writers — jq-equivalent merges to `settings.json` and
 * friends used by `omc setup`.
 *
 * Plan reference: /Users/peter/.claude-personal/plans/replicated-mixing-wren.md
 *   — "Config writer (`src/setup/config-writer.ts`)"
 *
 * Semantics match the bash port byte-for-byte:
 *   - `readJsonSafe` mirrors `jq . 2>/dev/null || echo null` (never throws on
 *     missing/corrupted files).
 *   - `mergeJsonShallow` mirrors `jq '. + {...}'` — preserves unknown user
 *     top-level keys; patch keys win on collision.
 *   - `setNestedJson` mirrors `jq '.env.VAR = "..."'` — creates intermediate
 *     objects, preserves sibling keys at every level.
 *
 * All writes go through an atomic tempfile+rename to avoid truncating the
 * user's config on ENOSPC, SIGINT, or power loss.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { getClaudeConfigDir } from '../utils/config-dir.js';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads and parses a JSON file. Returns `null` on any failure — missing file,
 * unreadable permissions, malformed JSON. The caller then decides whether to
 * start fresh with `{}` or surface an error.
 */
export function readJsonSafe<T = unknown>(path: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write (atomic)
// ---------------------------------------------------------------------------

function tempPathFor(path: string): string {
  const rand = randomBytes(6).toString('hex');
  return `${path}.tmp-${process.pid}-${rand}`;
}

/**
 * Atomically writes `content` to `path`:
 *   1. Ensures parent directory exists.
 *   2. Writes to a temp file in the same directory.
 *   3. fsyncs the temp file.
 *   4. renames temp → target (atomic on POSIX same-filesystem).
 *
 * If any step before rename fails, the temp file is unlinked and the target
 * is left untouched. On rename failure (ENOENT, EACCES), the temp file is also
 * cleaned up and the error is rethrown.
 */
export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', 0o644);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Serialize + atomic write of a JSON object. Matches bash `jq ... > tmp && mv`.
 * Uses 2-space indent + trailing newline (matches `jq` default output).
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  atomicWriteFile(path, serialized);
}

// ---------------------------------------------------------------------------
// Merge: shallow
// ---------------------------------------------------------------------------

/**
 * Shallow-merge `patch` onto the JSON at `path`. Preserves any top-level keys
 * the user has added that aren't in `patch` (matches `jq '. + {...}'`).
 *
 * If the file is missing or corrupted, starts fresh with `{}`.
 */
export function mergeJsonShallow(
  path: string,
  patch: Record<string, unknown>,
): void {
  const existing = (readJsonSafe<Record<string, unknown>>(path) ?? {});
  // Guard: if the existing file parsed to a non-object (array, string, number,
  // null), reset to {} so we don't produce invalid output. Matches the bash
  // behavior of `jq '. + {}'` which errors on non-objects — we're more lenient.
  const base: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? existing
      : {};
  const merged: Record<string, unknown> = { ...base, ...patch };
  writeJsonAtomic(path, merged);
}

// ---------------------------------------------------------------------------
// Merge: nested set
// ---------------------------------------------------------------------------

/**
 * Sets a deeply-nested key to `value`, creating intermediate objects as
 * needed. Preserves sibling keys at every level.
 *
 * Example: `setNestedJson('settings.json', ['env', 'OMC_MODE'], 'on')` matches
 * `jq '.env.OMC_MODE = "on"' settings.json`.
 *
 * If the file is missing or corrupted, starts fresh with `{}`.
 * Throws if `keyPath` is empty.
 */
export function setNestedJson(
  path: string,
  keyPath: string[],
  value: unknown,
): void {
  if (keyPath.length === 0) {
    throw new Error('setNestedJson: keyPath must have at least one key');
  }
  const existing = readJsonSafe<Record<string, unknown>>(path);
  const base: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...existing }
      : {};

  let cursor: Record<string, unknown> = base;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i]!;
    const next = cursor[key];
    if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      // Shallow-clone to avoid mutating the parsed-but-shared object tree.
      const cloned: Record<string, unknown> = { ...(next as Record<string, unknown>) };
      cursor[key] = cloned;
      cursor = cloned;
    } else {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    }
  }
  cursor[keyPath[keyPath.length - 1]!] = value;

  writeJsonAtomic(path, base);
}

// ---------------------------------------------------------------------------
// OMC config helper
// ---------------------------------------------------------------------------

export interface MergeOmcConfigOptions {
  /**
   * Override the config directory (e.g. `~/.claude`). Defaults to
   * `getClaudeConfigDir()`. Exposed so tests can point at a tmpdir.
   */
  configDir?: string;
  /**
   * Present for symmetry with the phase2 call site, which may want to scope
   * the merge to a per-project `.omc-config.json` in the future. Currently
   * unused — global config remains the single source of truth.
   */
  cwd?: string;
}

/**
 * Shallow-merge a patch into `[$CLAUDE_CONFIG_DIR|~/.claude]/.omc-config.json`.
 * Re-reads the file on every call — callers MUST NOT cache the previous
 * contents between phases, because `install()` may have written intermediate
 * changes (see phase2-configure.ts "install() + runSetup double-write" risk).
 */
export function mergeOmcConfig(
  patch: Record<string, unknown>,
  opts: MergeOmcConfigOptions = {},
): void {
  const dir = opts.configDir ?? getClaudeConfigDir();
  const path = join(dir, '.omc-config.json');
  mergeJsonShallow(path, patch);
}

// ---------------------------------------------------------------------------
// Claude settings.json helper
// ---------------------------------------------------------------------------

export interface MergeSettingsJsonOptions {
  /** Override the config directory. Defaults to `getClaudeConfigDir()`. */
  configDir?: string;
}

/**
 * Shallow-merge a patch into `[$CLAUDE_CONFIG_DIR|~/.claude]/settings.json`.
 * Re-reads on every call (same reasoning as `mergeOmcConfig`).
 *
 * This is the Claude Code settings file — it contains user-authored keys
 * that `omc setup` must preserve (themes, permissions, model overrides).
 * The shallow merge semantics match the bash shim's `jq '. + {...}'`.
 */
export function mergeSettingsJson(
  patch: Record<string, unknown>,
  opts: MergeSettingsJsonOptions = {},
): void {
  const dir = opts.configDir ?? getClaudeConfigDir();
  const path = join(dir, 'settings.json');
  mergeJsonShallow(path, patch);
}
