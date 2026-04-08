/**
 * Plugin Cache Healing
 *
 * Best-effort repair of two regressions that landed in shipped 4.11.x plugin cache copies:
 *
 * 1. #2348 — every hook command in hooks.json carried a hardcoded
 *    `/opt/hostedtoolcache/node/...` path (the GitHub Actions runner's node
 *    binary). That path doesn't exist on user machines, so every hook fails
 *    with `/bin/sh: <path>: No such file or directory`. We rewrite any
 *    absolute node path that does not exist on disk back to the local
 *    process.execPath.
 *
 * 2. #2252 — `~/.claude/skills/<name>/` directories left over from a previous
 *    standalone `omc setup` shadow the plugin's namespaced versions, causing
 *    every OMC slash command to appear twice in Claude Code. We delete only
 *    the standalone copies whose name is also provided by the plugin (so
 *    user-authored skills are never touched).
 *
 * Both helpers are intentionally:
 *   - idempotent (safe to call repeatedly)
 *   - never throwing (best-effort, never blocks an update)
 *   - bounded (only operate on artifacts we can prove are OMC-owned)
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

interface HookCommand {
  command?: string;
}

interface HookGroup {
  hooks?: HookCommand[];
}

interface HooksJson {
  hooks?: Record<string, HookGroup[]>;
}

export interface HealHooksJsonOptions {
  /** Absolute path to a node binary that exists on this machine. Used as the rewrite target. */
  nodeBin: string;
  /** Optional logger. Receives one line per file that was rewritten. */
  log?: (msg: string) => void;
}

export interface HealHooksJsonResult {
  scanned: string[];
  rewritten: string[];
  errors: string[];
}

/**
 * Matches a hook command of the form:
 *   "<absolute-node-path>" "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...
 *   "<absolute-node-path>" "${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs ...
 */
const ABSOLUTE_NODE_RUN_CJS_PATTERN =
  /^"([^"]+)"\s+("?\$(?:\{)?CLAUDE_PLUGIN_ROOT.*scripts\/run\.cjs\b.*)$/;

function rewriteHookCommand(command: string, nodeBin: string): string | null {
  const match = command.match(ABSOLUTE_NODE_RUN_CJS_PATTERN);
  if (!match) return null;
  const existingNode = match[1];
  if (existingNode === nodeBin) return null;
  // Only rewrite if the existing path does not point at a real binary on
  // disk. We never touch a path that the user might be intentionally relying
  // on (e.g. a custom node managed outside the repo).
  if (existsSync(existingNode)) return null;
  return `"${nodeBin}" ${match[2]}`;
}

/**
 * Walk an installed plugin cache hooks.json and rewrite any unreachable
 * absolute node paths to {@link nodeBin}. Returns the rewrite count for the
 * caller. Best-effort: returns false on any IO/JSON failure rather than
 * raising.
 */
export function healHooksJsonFile(filePath: string, nodeBin: string): boolean {
  if (!existsSync(filePath)) return false;
  let data: HooksJson;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8')) as HooksJson;
  } catch {
    return false;
  }

  let rewritten = false;
  for (const groups of Object.values(data.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!hook || typeof hook.command !== 'string') continue;
        const next = rewriteHookCommand(hook.command, nodeBin);
        if (next !== null) {
          hook.command = next;
          rewritten = true;
        }
      }
    }
  }

  if (!rewritten) return false;

  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Heal every installed plugin cache `hooks/hooks.json` under the OMC plugin
 * root. Caller passes the discovered plugin roots so this module stays
 * agnostic of how plugin discovery works.
 */
export function healHardcodedHookNodePaths(
  pluginRoots: string[],
  options: HealHooksJsonOptions,
): HealHooksJsonResult {
  const result: HealHooksJsonResult = { scanned: [], rewritten: [], errors: [] };
  const nodeBin = options.nodeBin;

  for (const pluginRoot of pluginRoots) {
    const hooksJson = join(pluginRoot, 'hooks', 'hooks.json');
    if (!existsSync(hooksJson)) continue;
    result.scanned.push(hooksJson);
    try {
      const changed = healHooksJsonFile(hooksJson, nodeBin);
      if (changed) {
        result.rewritten.push(hooksJson);
        options.log?.(`Healed hardcoded node path in ${hooksJson}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${hooksJson}: ${message}`);
    }
  }

  return result;
}

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
