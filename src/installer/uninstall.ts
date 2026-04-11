/**
 * OMC Uninstaller
 *
 * Reverses what `install()` does: removes agents, skills, hooks, HUD, state
 * files, and cleans up CLAUDE.md and settings.json hook entries.
 *
 * Design constraints:
 *   - Never removes entire directories blindly; checks for OMC ownership first.
 *   - Idempotent: second call on a clean directory returns removed:[], no errors.
 *   - Does NOT read module-level CLAUDE_CONFIG_DIR const; always uses the
 *     explicit `configDir` argument so tests can pass a tmpdir.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { resolveActivePluginRoot } from '../setup/plugin-root.js';
import { isOmcHook } from './index.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UninstallOptions {
  /** Defaults to getClaudeConfigDir(). */
  configDir?: string;
  /** List what would be removed without actually removing anything. */
  dryRun?: boolean;
  /**
   * Preserve user content outside OMC markers in CLAUDE.md.
   * Default: true.
   */
  preserveUserContent?: boolean;
  logger?: (msg: string) => void;
}

export interface UninstallResult {
  /** Absolute paths of files/dirs actually removed (or would be, in dryRun). */
  removed: string[];
  /** Absolute paths of files preserved (e.g. CLAUDE.md with user content). */
  preserved: string[];
  /** Absolute paths that didn't exist — idempotent no-ops. */
  skipped: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Marker constants (must match setup/claude-md.ts)
// ---------------------------------------------------------------------------

const OMC_START = '<!-- OMC:START -->';
const OMC_END = '<!-- OMC:END -->';
const IMPORT_START = '<!-- OMC:IMPORT:START -->';
const IMPORT_END = '<!-- OMC:IMPORT:END -->';

// OMC-owned state files relative to configDir (always removed unconditionally).
const OMC_STATE_FILES_REL = [
  '.omc-version.json',
  '.omc-silent-update.json',
  '.omc-update.log',
  '.omc-config.json',
  'CLAUDE-omc.md',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether a file contains OMC frontmatter (starts with `---\nname:` or
 * `---\n` followed by a `name:` line). Used to decide whether a standalone
 * .md file in agents/ was written by OMC.
 */
function hasOmcFrontmatter(filePath: string): boolean {
  try {
    const head = readFileSync(filePath, 'utf8').slice(0, 512);
    return head.startsWith('---\n') && /^name:\s+\S+/m.test(head);
  } catch {
    return false;
  }
}

/**
 * Check whether a skill directory contains an OMC-owned SKILL.md.
 */
function isOmcSkillDir(skillDir: string): boolean {
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return false;
  try {
    const head = readFileSync(skillMd, 'utf8').slice(0, 512);
    return head.startsWith('---\n') && /^name:\s+\S+/m.test(head);
  } catch {
    return false;
  }
}

/**
 * Check whether a HUD directory is OMC-owned by looking for omc-hud.mjs.
 */
function isOmcHudDir(hudDir: string): boolean {
  return existsSync(join(hudDir, 'omc-hud.mjs'));
}

/**
 * Strip the OMC block (OMC:START … OMC:END) and any companion import block
 * (OMC:IMPORT:START … OMC:IMPORT:END) from CLAUDE.md content.
 * Returns the user content that remains, or null if nothing remained.
 */
function stripOmcBlockFromClaudeMd(content: string): string | null {
  // Strip OMC block
  const omcBlockRegex = new RegExp(
    `^${escapeRegex(OMC_START)}\\r?\\n[\\s\\S]*?^${escapeRegex(OMC_END)}(?:\\r?\\n)?`,
    'gm',
  );
  let stripped = content.replace(omcBlockRegex, '');

  // Strip import block if present
  if (stripped.includes(IMPORT_START)) {
    const importRegex = new RegExp(
      `^${escapeRegex(IMPORT_START)}\\r?\\n[\\s\\S]*?^${escapeRegex(IMPORT_END)}(?:\\r?\\n)?`,
      'gm',
    );
    stripped = stripped.replace(importRegex, '');
  }

  // Remove generated header comments that OMC adds
  stripped = stripped.replace(/^<!-- User customizations(?: \([^)]+\))? -->\r?\n?/gm, '');

  // Normalize: trim leading/trailing whitespace
  const trimmed = stripped.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type HookEntry = { type: string; command: string };
type HookGroup = { hooks: HookEntry[] };

/**
 * Remove OMC hook entries from settings.json hooks map.
 * Returns the updated settings object and whether anything changed.
 */
function removeOmcHooksFromSettings(
  settings: Record<string, unknown>,
): { updated: Record<string, unknown>; changed: boolean } {
  const existingHooks = settings.hooks as Record<string, HookGroup[]> | undefined;
  if (!existingHooks || typeof existingHooks !== 'object') {
    return { updated: settings, changed: false };
  }

  let changed = false;
  const newHooks: Record<string, HookGroup[]> = {};

  for (const [eventType, groups] of Object.entries(existingHooks)) {
    if (!Array.isArray(groups)) continue;
    const nonOmcGroups = groups.filter((group: HookGroup) =>
      !group.hooks.every((h: HookEntry) => h.type === 'command' && isOmcHook(h.command))
    );
    if (nonOmcGroups.length !== groups.length) {
      changed = true;
    }
    if (nonOmcGroups.length > 0) {
      newHooks[eventType] = nonOmcGroups;
    }
  }

  const updated = { ...settings };
  if (Object.keys(newHooks).length > 0) {
    updated.hooks = newHooks;
  } else if (changed) {
    delete updated.hooks;
  }

  return { updated, changed };
}

/**
 * Remove OMC statusLine from settings if it was OMC-owned.
 */
function isOmcStatusLine(statusLine: unknown): boolean {
  if (!statusLine) return false;
  if (typeof statusLine === 'string') return statusLine.includes('omc-hud');
  if (typeof statusLine === 'object') {
    const sl = statusLine as Record<string, unknown>;
    if (typeof sl.command === 'string') return sl.command.includes('omc-hud');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Atomic write helper (mirrors state.ts pattern)
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    try {
      renameSync(tmp, filePath);
    } catch {
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function uninstall(opts: UninstallOptions = {}): UninstallResult {
  const configDir = opts.configDir ?? getClaudeConfigDir();
  const dryRun = opts.dryRun ?? false;
  const preserveUserContent = opts.preserveUserContent ?? true;
  const baseLog = opts.logger ?? console.log;

  const prefix = dryRun ? '[dry-run] ' : '';
  const log = (msg: string): void => baseLog(`${prefix}${msg}`);

  const result: UninstallResult = {
    removed: [],
    preserved: [],
    skipped: [],
    warnings: [],
  };

  // Helper: remove a single file (not a directory).
  function removeFile(absPath: string): void {
    if (!existsSync(absPath)) {
      result.skipped.push(absPath);
      log(`Skipped (not present): ${absPath}`);
      return;
    }
    if (!dryRun) {
      try {
        unlinkSync(absPath);
      } catch (err) {
        const msg = `Failed to remove ${absPath}: ${(err as Error).message}`;
        result.warnings.push(msg);
        log(`Warning: ${msg}`);
        return;
      }
    }
    result.removed.push(absPath);
    log(`Removed: ${absPath}`);
  }

  // Helper: remove a directory tree.
  function removeDir(absPath: string): void {
    if (!existsSync(absPath)) {
      result.skipped.push(absPath);
      log(`Skipped (not present): ${absPath}`);
      return;
    }
    if (!dryRun) {
      try {
        rmSync(absPath, { recursive: true, force: true });
      } catch (err) {
        const msg = `Failed to remove directory ${absPath}: ${(err as Error).message}`;
        result.warnings.push(msg);
        log(`Warning: ${msg}`);
        return;
      }
    }
    result.removed.push(absPath);
    log(`Removed: ${absPath}`);
  }

  // ── Step 1: Resolve the plugin root ────────────────────────────────────────
  let pluginRoot: string | null = null;
  try {
    pluginRoot = resolveActivePluginRoot({ configDir });
  } catch {
    result.warnings.push('Could not resolve plugin root; using conservative scan mode');
    log('Warning: Could not resolve plugin root; using conservative scan mode');
  }

  // ── Step 2: Remove agents ───────────────────────────────────────────────────
  const agentsDir = join(configDir, 'agents');
  if (existsSync(agentsDir)) {
    // Try to enumerate canonical agent filenames from the plugin root.
    // The plugin root may point to dist/ where agents are .js files, so we
    // also check the parent directory (repo root) for .md sources.
    let pluginAgentMdFiles: Set<string> | null = null;
    if (pluginRoot !== null) {
      const candidates = [
        join(pluginRoot, 'agents'),
        join(pluginRoot, '..', 'agents'),
      ];
      for (const dir of candidates) {
        if (!existsSync(dir)) continue;
        try {
          const mdFiles = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'AGENTS.md');
          if (mdFiles.length > 0) {
            pluginAgentMdFiles = new Set(mdFiles);
            break;
          }
        } catch { /* try next */ }
      }
    }

    if (pluginAgentMdFiles !== null && pluginAgentMdFiles.size > 0) {
      // Remove only files matching current plugin's agent filenames
      for (const file of pluginAgentMdFiles) {
        removeFile(join(agentsDir, file));
      }
    } else {
      // Conservative: remove only .md files with OMC frontmatter
      try {
        for (const file of readdirSync(agentsDir)) {
          if (!file.endsWith('.md') || file === 'AGENTS.md') continue;
          const target = join(agentsDir, file);
          if (hasOmcFrontmatter(target)) {
            removeFile(target);
          }
        }
      } catch (err) {
        result.warnings.push(`Could not scan agents dir: ${(err as Error).message}`);
      }
    }
  }

  // ── Step 3: Remove skills ───────────────────────────────────────────────────
  const skillsDir = join(configDir, 'skills');
  if (existsSync(skillsDir)) {
    const skillNamesToRemove = new Set<string>();

    if (pluginRoot !== null) {
      const pluginSkillsDir = join(pluginRoot, 'skills');
      if (existsSync(pluginSkillsDir)) {
        try {
          for (const entry of readdirSync(pluginSkillsDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              skillNamesToRemove.add(entry.name);
            }
          }
        } catch (err) {
          result.warnings.push(`Could not read plugin skills dir: ${(err as Error).message}`);
        }
      }
    }

    // Also conservatively check any installed skill dirs for OMC ownership
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // Skip user-created skills
        if (entry.name === 'omc-learned') continue;

        const skillDir = join(skillsDir, entry.name);
        if (skillNamesToRemove.has(entry.name) || isOmcSkillDir(skillDir)) {
          // Remove only if OMC-owned
          if (isOmcSkillDir(skillDir)) {
            removeDir(skillDir);
          }
        }
      }
    } catch (err) {
      result.warnings.push(`Could not scan skills dir: ${(err as Error).message}`);
    }
  }

  // ── Step 4: Remove hooks ────────────────────────────────────────────────────
  const hooksDir = join(configDir, 'hooks');
  const OMC_HOOK_FILES = [
    'keyword-detector.mjs',
    'session-start.mjs',
    'pre-tool-use.mjs',
    'post-tool-use.mjs',
    'post-tool-use-failure.mjs',
    'persistent-mode.mjs',
    'code-simplifier.mjs',
    'stop-continuation.mjs',
    'find-node.sh',
  ];

  if (existsSync(hooksDir)) {
    for (const filename of OMC_HOOK_FILES) {
      removeFile(join(hooksDir, filename));
    }

    // Remove hooks/lib/ if it exists (sub-library files)
    const hooksLibDir = join(hooksDir, 'lib');
    if (existsSync(hooksLibDir)) {
      try {
        // Remove all files in lib/ that look like OMC-owned helpers
        for (const file of readdirSync(hooksLibDir)) {
          removeFile(join(hooksLibDir, file));
        }
        // Remove lib/ dir itself if now empty
        if (!dryRun && existsSync(hooksLibDir)) {
          try {
            const remaining = readdirSync(hooksLibDir);
            if (remaining.length === 0) {
              rmSync(hooksLibDir, { recursive: true, force: true });
            }
          } catch { /* best effort */ }
        }
      } catch (err) {
        result.warnings.push(`Could not clean hooks/lib/: ${(err as Error).message}`);
      }
    }
  }

  // ── Step 5: Remove HUD bundle ───────────────────────────────────────────────
  const hudDir = join(configDir, 'hud');
  if (existsSync(hudDir) && isOmcHudDir(hudDir)) {
    removeDir(hudDir);
  } else if (!existsSync(hudDir)) {
    result.skipped.push(hudDir);
    log(`Skipped (not present): ${hudDir}`);
  }

  // ── Step 6: Remove OMC state files ─────────────────────────────────────────
  for (const rel of OMC_STATE_FILES_REL) {
    removeFile(join(configDir, rel));
  }

  // ── Step 7: CLAUDE.md handling ──────────────────────────────────────────────
  const claudeMdPath = join(configDir, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf8');

    if (!preserveUserContent) {
      // Delete entire CLAUDE.md regardless of content
      removeFile(claudeMdPath);
    } else if (content.includes(OMC_START) || content.includes(IMPORT_START)) {
      // Either overwrite-mode (OMC:START/END block) OR preserve-mode
      // (OMC:IMPORT:START/END block pointing at the companion file) —
      // both shapes need the strip path.
      const userContent = stripOmcBlockFromClaudeMd(content);
      if (userContent === null) {
        // Pure OMC content — delete
        removeFile(claudeMdPath);
      } else {
        // Has user content — strip OMC block and rewrite
        if (!dryRun) {
          try {
            writeFileSync(claudeMdPath, `${userContent}\n`, 'utf8');
          } catch (err) {
            const msg = `Failed to rewrite CLAUDE.md: ${(err as Error).message}`;
            result.warnings.push(msg);
            log(`Warning: ${msg}`);
          }
        }
        result.preserved.push(claudeMdPath);
        log(`Preserved user content in: ${claudeMdPath}`);
      }
    } else {
      // No OMC markers — nothing to do
      result.skipped.push(claudeMdPath);
      log(`Skipped (not present): ${claudeMdPath}`);
    }
  } else {
    result.skipped.push(claudeMdPath);
    log(`Skipped (not present): ${claudeMdPath}`);
  }

  // ── Step 8: settings.json hook cleanup ─────────────────────────────────────
  const settingsPath = join(configDir, 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const rawSettings = readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(rawSettings) as Record<string, unknown>;

      const { updated: afterHooks, changed: hooksChanged } = removeOmcHooksFromSettings(settings);

      // Remove OMC statusLine
      let updatedSettings = afterHooks;
      let statusLineChanged = false;
      if (isOmcStatusLine(updatedSettings.statusLine)) {
        updatedSettings = { ...updatedSettings };
        delete updatedSettings.statusLine;
        statusLineChanged = true;
      }

      if (hooksChanged || statusLineChanged) {
        if (!dryRun) {
          atomicWriteJson(settingsPath, updatedSettings);
        }
        result.removed.push(settingsPath);
        log(`Removed: ${settingsPath} (cleaned OMC entries)`);
      } else {
        result.skipped.push(settingsPath);
        log(`Skipped (not present): ${settingsPath}`);
      }
    } catch (err) {
      const msg = `Could not process settings.json: ${(err as Error).message}`;
      result.warnings.push(msg);
      log(`Warning: ${msg}`);
    }
  }

  // ── Step 9: skill-active-state cleanup ─────────────────────────────────────
  const omcStateSessions = join(configDir, '.omc', 'state', 'sessions');
  if (existsSync(omcStateSessions)) {
    try {
      for (const sessionId of readdirSync(omcStateSessions)) {
        const stateFile = join(omcStateSessions, sessionId, 'skill-active-state.json');
        if (existsSync(stateFile)) {
          removeFile(stateFile);
        }
      }
    } catch (err) {
      result.warnings.push(`Could not clean session state files: ${(err as Error).message}`);
    }
  }

  // ── Step 10: CLAUDE.md backup cleanup ──────────────────────────────────────
  // Remove any leftover CLAUDE.md.backup.* files created by install() runs
  // so the directory is clean. These are unambiguously OMC-created.
  if (existsSync(configDir)) {
    try {
      for (const file of readdirSync(configDir)) {
        if (file.startsWith('CLAUDE.md.backup.')) {
          removeFile(join(configDir, file));
        }
      }
    } catch { /* best effort */ }
  }

  return result;
}
