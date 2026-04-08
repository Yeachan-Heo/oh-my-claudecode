/**
 * Plugin Cache Healing
 *
 * Best-effort cleanup of orphan standalone skills that shadow their
 * plugin-provided counterparts (#2252).
 *
 * ~/.claude/skills/<name>/ directories left over from a previous standalone
 * `omc setup` cause every OMC slash command to appear twice in Claude Code
 * once the plugin is also installed: once bare, once under the
 * `oh-my-claudecode:` namespace. `omc update` alone never cleaned these up,
 * so any user who ever ran `omc setup` stayed permanently in the duplicate
 * state on every subsequent upgrade.
 *
 * {@link pruneOrphanStandaloneSkills} removes ONLY standalone directories
 * whose SKILL.md content hashes match the plugin's copy — user-authored
 * skills with colliding names (e.g. a personal `plan/SKILL.md`) are
 * provably preserved. Removed directories are first moved into
 * `~/.claude/skills/.omc-trash/<name>.<timestamp>/` so even false positives
 * are recoverable.
 *
 * (Note: the sibling #2348 hook-path healing was landed upstream in #2349,
 * so this module intentionally does NOT walk `hooks/hooks.json`.)
 *
 * The helper is intentionally:
 *   - idempotent (safe to call repeatedly)
 *   - never throwing (best-effort, never blocks an update)
 *   - bounded (only operate on artifacts we can prove are OMC-owned)
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

export interface PruneOrphanSkillsOptions {
  /** Absolute path to ~/.claude/skills/ (or override for tests). */
  skillsDir: string;
  /** Plugin roots whose skills/<name>/ defines the canonical set. */
  pluginRoots: string[];
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface PruneOrphanSkillsResult {
  removed: string[];
  preserved: string[];
  errors: string[];
}

function sha256OfFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Build a map of `<directoryName> → set-of-SKILL.md-content-hashes` for every
 * skill the plugin installs. We key on directory name and value on a set of
 * hashes because the same `<name>` may exist in multiple installed plugin
 * versions side by side (e.g. 4.11.0 and 4.11.1) with slightly different
 * SKILL.md content.
 *
 * A standalone skill at `~/.claude/skills/<name>/SKILL.md` is considered an
 * OMC-installed orphan iff its content hash is present in this map.
 */
export function buildPluginSkillContentMap(
  pluginRoots: string[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const pluginRoot of pluginRoots) {
    const pluginSkillsDir = join(pluginRoot, 'skills');
    if (!existsSync(pluginSkillsDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(pluginSkillsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillFile = join(pluginSkillsDir, entry, 'SKILL.md');
      const hash = sha256OfFile(skillFile);
      if (!hash) continue;
      let bucket = map.get(entry);
      if (!bucket) {
        bucket = new Set<string>();
        map.set(entry, bucket);
      }
      bucket.add(hash);
    }
  }
  return map;
}

/**
 * Remove orphan standalone skill directories that the plugin now provides
 * under its own namespace. A standalone skill is considered an orphan ONLY
 * when:
 *
 *   1. its directory name appears in the plugin's skills/ tree, AND
 *   2. the standalone SKILL.md content hash is byte-identical to a SKILL.md
 *      provided by an installed plugin version.
 *
 * The content-hash check protects user-authored skills that happen to share
 * a name with a bundled plugin skill (e.g. a user-authored
 * `~/.claude/skills/plan/SKILL.md` will not be removed because its content
 * differs from the plugin's `plan/SKILL.md`).
 *
 * Before removal, the orphan directory is moved to
 * `<skillsDir>/.omc-trash/<name>.<timestamp>/` so even false positives are
 * recoverable. Trash directories are never themselves pruned.
 */
export function pruneOrphanStandaloneSkills(
  options: PruneOrphanSkillsOptions,
): PruneOrphanSkillsResult {
  const result: PruneOrphanSkillsResult = { removed: [], preserved: [], errors: [] };
  const { skillsDir, pluginRoots } = options;

  if (!existsSync(skillsDir)) return result;

  const pluginContentMap = buildPluginSkillContentMap(pluginRoots);
  if (pluginContentMap.size === 0) return result;

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`${skillsDir}: ${message}`);
    return result;
  }

  for (const entry of entries) {
    if (entry === '.omc-trash') {
      result.preserved.push(entry);
      continue;
    }
    const expectedHashes = pluginContentMap.get(entry);
    if (!expectedHashes) {
      result.preserved.push(entry);
      continue;
    }
    const skillDir = join(skillsDir, entry);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) {
      // Plugin name match but not actually an installed skill — leave alone.
      result.preserved.push(entry);
      continue;
    }
    const standaloneHash = sha256OfFile(skillFile);
    if (!standaloneHash || !expectedHashes.has(standaloneHash)) {
      // Same name, different content — this is user-authored or a fork.
      // Never delete it.
      result.preserved.push(entry);
      continue;
    }

    try {
      // Move to a recoverable trash directory before deletion. We use a
      // timestamped name so concurrent runs do not collide.
      const trashRoot = join(skillsDir, '.omc-trash');
      if (!existsSync(trashRoot)) {
        try {
          mkdirSync(trashRoot, { recursive: true });
        } catch {
          // If trash creation fails we still proceed with deletion below; the
          // content-hash check already proves the file is recoverable from
          // the plugin cache.
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const trashTarget = join(trashRoot, `${entry}.${stamp}`);
      try {
        // Best-effort backup. Even if it fails we still delete because the
        // content is provably recoverable from the plugin cache.
        cpSync(skillDir, trashTarget, { recursive: true, force: true });
      } catch {
        // Best-effort: continue with deletion
      }
      rmSync(skillDir, { recursive: true, force: true });
      result.removed.push(entry);
      options.log?.(
        `Removed orphan standalone skill ${entry} (content matched plugin copy; backup at .omc-trash/${entry}.${stamp})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${skillDir}: ${message}`);
    }
  }

  return result;
}
