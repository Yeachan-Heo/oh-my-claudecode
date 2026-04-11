/**
 * CLAUDE.md installation / merge / preserve-mode orchestration.
 *
 * TypeScript port of scripts/setup-claude-md.sh (422 lines).
 *
 * The 22 numbered behaviors below map 1:1 to rows in the "Phase 1 port"
 * behavior table of the replicated-mixing-wren plan. Every behavior has
 * a corresponding unit test in __tests__/claude-md.test.ts.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { getRuntimePackageVersion } from '../lib/version.js';
import { resolveActivePluginRoot } from './plugin-root.js';
import { installOmcReferenceSkill } from './omc-reference.js';

// ───────────────────────────── constants ─────────────────────────────

const START_MARKER = '<!-- OMC:START -->';
const END_MARKER = '<!-- OMC:END -->';
const IMPORT_START = '<!-- OMC:IMPORT:START -->';
const IMPORT_END = '<!-- OMC:IMPORT:END -->';
const COMPANION_FILENAME = 'CLAUDE-omc.md';
const USER_CUSTOMIZATIONS = '<!-- User customizations -->';
const USER_CUSTOMIZATIONS_RECOVERED = '<!-- User customizations (recovered from corrupted markers) -->';
const USER_CUSTOMIZATIONS_MIGRATED = '<!-- User customizations (migrated from previous CLAUDE.md) -->';
const OMC_VERSION_REGEX = /<!-- OMC:VERSION:([^\s]+?) -->/;

/**
 * Canonical GitHub fallback URL. Only used when neither the active plugin
 * root nor `CLAUDE_PLUGIN_ROOT` has `docs/CLAUDE.md` on disk.
 */
export const DOWNLOAD_URL = 'https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md';

// ─────────────────────────── local helpers ───────────────────────────

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createLineAnchoredMarkerRegex(marker: string, flags: string = 'gm'): RegExp {
  return new RegExp(`^${escapeRegex(marker)}$`, flags);
}

function findLineAnchoredMarker(content: string, marker: string, fromEnd: boolean = false): number {
  const regex = createLineAnchoredMarkerRegex(marker);
  if (fromEnd) {
    let lastIndex = -1;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      lastIndex = match.index;
    }
    return lastIndex;
  }
  const match = regex.exec(content);
  return match ? match.index : -1;
}

function stripGeneratedUserCustomizationHeaders(content: string): string {
  return content.replace(/^<!-- User customizations(?: \([^)]+\))? -->\r?\n?/gm, '');
}

function trimClaudeUserContent(content: string): string {
  if (content.trim().length === 0) return '';
  return content
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '')
    .replace(/(?:\r?\n){3,}/g, '\n\n');
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Build an `YYYY-MM-DD_HHMMSS` backup-date stamp (matches
 * `date +%Y-%m-%d_%H%M%S` exactly).
 */
function formatBackupDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// ───────────────────────── numbered behaviors ────────────────────────

/**
 * Behavior #2 — `ensure_local_omc_git_exclude` (bash lines 95-125).
 *
 * Resolves `.git/info/exclude` via `git rev-parse --git-path info/exclude`
 * so it works inside worktrees. Idempotent: a second call is a no-op when
 * the marker block is already present.
 */
export function ensureLocalOmcGitExclude(opts: { cwd?: string; logger?: (line: string) => void } = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.logger ?? ((line: string) => console.log(line));

  const result = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) {
    log('Skipped OMC git exclude setup (not a git repository)');
    return;
  }
  const raw = result.stdout.trim();
  if (!raw) {
    log('Skipped OMC git exclude setup (not a git repository)');
    return;
  }
  const excludePath = isAbsolute(raw) ? raw : join(cwd, raw);

  mkdirSync(dirname(excludePath), { recursive: true });

  const blockStart = '# BEGIN OMC local artifacts';
  const block = `# BEGIN OMC local artifacts
.omc/*
!.omc/skills/
!.omc/skills/**
# END OMC local artifacts
`;

  if (existsSync(excludePath)) {
    const existing = readFileSync(excludePath, 'utf8');
    if (existing.includes(blockStart)) {
      log('OMC git exclude already configured');
      return;
    }
    // Bash: if [ -f "$exclude_path" ] && [ -s "$exclude_path" ]; then printf '\n' >> ... fi
    // Non-empty file → insert a blank line before the block so it doesn't
    // run-on with the previous entry. Empty file → no prefix.
    const separator = existing.length > 0 ? '\n' : '';
    writeFileSync(excludePath, existing + separator + block, 'utf8');
  } else {
    writeFileSync(excludePath, block, 'utf8');
  }

  log('Configured git exclude for local .omc artifacts (preserving .omc/skills/)');
}

/**
 * Behavior #4 — Target-path resolution (bash lines 127-140).
 */
export interface TargetPaths {
  targetPath: string;
  skillTargetPath: string;
  companionPath: string;
}

export function resolveTargetPaths(
  mode: 'local' | 'global',
  configDir: string,
  cwd: string = process.cwd(),
): TargetPaths {
  if (mode === 'local') {
    const base = join(cwd, '.claude');
    return {
      targetPath: join(base, 'CLAUDE.md'),
      skillTargetPath: join(base, 'skills', 'omc-reference', 'SKILL.md'),
      companionPath: join(base, COMPANION_FILENAME),
    };
  }
  return {
    targetPath: join(configDir, 'CLAUDE.md'),
    skillTargetPath: join(configDir, 'skills', 'omc-reference', 'SKILL.md'),
    companionPath: join(configDir, COMPANION_FILENAME),
  };
}

/**
 * Behavior #6 — Old-version extraction (bash lines 178-184).
 *
 * 1. `OMC:VERSION:` marker in the existing file → use that
 * 2. File exists but no marker → fall back to the runtime package version
 *    (NOT `omc --version`; that would recurse into `omc setup`)
 * 3. File missing → `'none'` (signals "fresh install" to `reportVersionChange`)
 */
export function extractOldVersion(targetPath: string): string {
  if (!existsSync(targetPath)) return 'none';
  try {
    const content = readFileSync(targetPath, 'utf8');
    const match = content.match(OMC_VERSION_REGEX);
    if (match?.[1]) return match[1];
  } catch {
    // fall through to package-version fallback
  }
  try {
    const v = getRuntimePackageVersion();
    if (v) return v;
  } catch {
    // last-resort fallback below
  }
  return 'none';
}

/**
 * Behavior #7 — Timestamped backup (bash lines 187-193).
 */
export interface BackupResult {
  backupDate: string;
  backupPath: string | null;
}

export function backupIfExists(
  targetPath: string,
  opts: { logger?: (line: string) => void; now?: Date } = {},
): BackupResult {
  const log = opts.logger ?? ((line: string) => console.log(line));
  if (!existsSync(targetPath)) {
    return { backupDate: '', backupPath: null };
  }
  const backupDate = formatBackupDate(opts.now);
  const backupPath = `${targetPath}.backup.${backupDate}`;
  copyFileSync(targetPath, backupPath);
  log(`Backed up existing CLAUDE.md to ${backupPath}`);
  return { backupDate, backupPath };
}

/**
 * Behavior #8 — Canonical OMC content fallback chain (bash lines 249-258).
 *
 * 1. `<pluginRoot>/docs/CLAUDE.md` if present
 * 2. `$CLAUDE_PLUGIN_ROOT/docs/CLAUDE.md` if present
 * 3. GitHub fetch via Node 20+ global `fetch` (NOT external curl)
 */
export interface LoadCanonicalResult {
  content: string;
  sourceLabel: string;
}

export async function loadCanonicalOmcContent(
  pluginRoot: string,
  opts: { downloadUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<LoadCanonicalResult> {
  const canonical = join(pluginRoot, 'docs', 'CLAUDE.md');
  if (existsSync(canonical)) {
    return { content: readFileSync(canonical, 'utf8'), sourceLabel: canonical };
  }

  const envRoot = process.env['CLAUDE_PLUGIN_ROOT'];
  if (envRoot) {
    const envCanonical = join(envRoot, 'docs', 'CLAUDE.md');
    if (existsSync(envCanonical)) {
      return { content: readFileSync(envCanonical, 'utf8'), sourceLabel: envCanonical };
    }
  }

  const url = opts.downloadUrl ?? DOWNLOAD_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      `Failed to download CLAUDE.md. Aborting.\nFALLBACK: Manually download from: ${url}`,
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new Error(
      `Failed to download CLAUDE.md from ${url}: ${(err as Error).message}\n` +
      `FALLBACK: Manually download from: ${url}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to download CLAUDE.md from ${url}: HTTP ${response.status}\n` +
      `FALLBACK: Manually download from: ${url}`,
    );
  }
  const content = await response.text();
  if (!content || content.length === 0) {
    throw new Error(
      `Failed to download CLAUDE.md. Aborting.\nFALLBACK: Manually download from: ${url}`,
    );
  }
  return { content, sourceLabel: url };
}

/**
 * Behavior #9 — Canonical-source marker validation (bash lines 267-271).
 */
export function validateOmcMarkers(content: string, sourceLabel: string): void {
  if (!content.includes(START_MARKER) || !content.includes(END_MARKER)) {
    throw new Error(
      `Canonical CLAUDE.md source is missing required OMC markers: ${sourceLabel}\n` +
      `Refusing to install a summarized or malformed CLAUDE.md.`,
    );
  }
}

/**
 * Behavior #10 — Strip outer OMC markers for idempotency (bash lines 273-278).
 *
 * Returns the content strictly BETWEEN the first `OMC:START` and last
 * `OMC:END` lines (exclusive of both marker lines), matching the awk
 * program at bash line 276.
 */
export function stripOmcMarkers(content: string): string {
  const startIdx = findLineAnchoredMarker(content, START_MARKER);
  const endIdx = findLineAnchoredMarker(content, END_MARKER, true);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    return content;
  }
  // The start marker is on its own line; advance past its newline.
  const startLineEnd = content.indexOf('\n', startIdx);
  const innerStart = startLineEnd === -1 ? startIdx + START_MARKER.length : startLineEnd + 1;
  // Trim any trailing newline immediately before the end-marker line so
  // the re-wrap step doesn't double up.
  let innerEnd = endIdx;
  if (innerEnd > 0 && content[innerEnd - 1] === '\n') {
    innerEnd -= 1;
  }
  return content.substring(innerStart, innerEnd);
}

/**
 * Additional helper — `ensure_not_symlink_path` (bash lines 236-244).
 *
 * Exact error text: `Refusing to write <label> because the destination is
 * a symlink: <path>` — asserted by H7 and the parity test.
 */
export function ensureNotSymlinkPath(targetPath: string, label: string): void {
  const stat = safeLstat(targetPath);
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`Refusing to write ${label} because the destination is a symlink: ${targetPath}`);
  }
}

/**
 * Behavior #11 — `write_wrapped_omc_file` (bash lines 203-211).
 *
 * Produces: `START_MARKER\n<omcContent>\nEND_MARKER\n` — matches the bash
 * `echo … cat … echo` concatenation byte-for-byte (modulo any trailing
 * newline already present in `omcContent`).
 */
export function writeWrappedOmcFile(destination: string, omcContent: string): void {
  ensureNotSymlinkPath(destination, 'CLAUDE.md');
  mkdirSync(dirname(destination), { recursive: true });
  const body = omcContent.endsWith('\n') ? omcContent : `${omcContent}\n`;
  const wrapped = `${START_MARKER}\n${body}${END_MARKER}\n`;
  writeFileSync(destination, wrapped, 'utf8');
}

/**
 * Additional helper — `ensure_managed_companion_import` (bash lines 213-234).
 *
 * Strips any existing `OMC:IMPORT` block, then appends a fresh block
 * pointing at `companionName`. Idempotent.
 */
export function ensureManagedCompanionImport(targetPath: string, companionName: string): void {
  const importBlock = `${IMPORT_START}\n@${companionName}\n${IMPORT_END}`;

  let current = '';
  if (existsSync(targetPath)) {
    current = readFileSync(targetPath, 'utf8');
    if (current.includes(IMPORT_START)) {
      const importRegex = new RegExp(
        `^${escapeRegex(IMPORT_START)}\\r?\\n[\\s\\S]*?^${escapeRegex(IMPORT_END)}(?:\\r?\\n)?`,
        'gm',
      );
      current = current.replace(importRegex, '');
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  // Bash: if [ -s ] then `printf '\n\n%s\n'` else `printf '%s\n'`
  const newContent = current.length > 0
    ? `${current}\n\n${importBlock}\n`
    : `${importBlock}\n`;
  writeFileSync(targetPath, newContent, 'utf8');
}

/**
 * Behavior #12 — Marker-aware merge with corrupted-marker recovery
 * (bash lines 286-320).
 *
 * This is the ported equivalent of the former `mergeClaudeMd()` in
 * `src/installer/index.ts:1091-1148`. The TS version keeps a divergence
 * from bash that the existing installer tests already pin: residual
 * unmatched markers are stripped from the recovered content (rather than
 * preserved verbatim) to prevent unbounded growth on repeated re-runs —
 * regression test lives in `src/installer/__tests__/claude-md-merge.test.ts`.
 */
export function mergeClaudeMd(
  existingContent: string | null,
  omcContent: string,
  version?: string,
): string {
  const OMC_BLOCK_PATTERN = new RegExp(
    `^${escapeRegex(START_MARKER)}\\r?\\n[\\s\\S]*?^${escapeRegex(END_MARKER)}(?:\\r?\\n)?`,
    'gm',
  );
  const markerStartRegex = createLineAnchoredMarkerRegex(START_MARKER);
  const markerEndRegex = createLineAnchoredMarkerRegex(END_MARKER);

  // Idempotency guard: strip markers from omcContent if already present
  let cleanOmcContent = omcContent;
  const omcStartIdx = findLineAnchoredMarker(omcContent, START_MARKER);
  const omcEndIdx = findLineAnchoredMarker(omcContent, END_MARKER, true);
  if (omcStartIdx !== -1 && omcEndIdx !== -1 && omcStartIdx < omcEndIdx) {
    cleanOmcContent = omcContent
      .substring(omcStartIdx + START_MARKER.length, omcEndIdx)
      .trim();
  }

  // Strip embedded version marker; optionally re-inject `version`
  cleanOmcContent = cleanOmcContent.replace(/<!-- OMC:VERSION:[^\s]*? -->\n?/, '');
  const versionMarker = version ? `<!-- OMC:VERSION:${version} -->\n` : '';

  if (!existingContent) {
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n`;
  }

  const strippedExistingContent = existingContent.replace(OMC_BLOCK_PATTERN, '');
  const hasResidualStartMarker = markerStartRegex.test(strippedExistingContent);
  const hasResidualEndMarker = markerEndRegex.test(strippedExistingContent);

  if (hasResidualStartMarker || hasResidualEndMarker) {
    const recoveredContent = strippedExistingContent
      .replace(createLineAnchoredMarkerRegex(START_MARKER), '')
      .replace(createLineAnchoredMarkerRegex(END_MARKER), '')
      .trim();
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS_RECOVERED}\n${recoveredContent}`;
  }

  const preservedUserContent = trimClaudeUserContent(
    stripGeneratedUserCustomizationHeaders(strippedExistingContent),
  );

  if (!preservedUserContent) {
    return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n`;
  }

  return `${START_MARKER}\n${versionMarker}${cleanOmcContent}\n${END_MARKER}\n\n${USER_CUSTOMIZATIONS}\n${preservedUserContent}`;
}

/** Behavior #12 (alias) — port of bash `mergeOmcBlock`. Delegates to `mergeClaudeMd`. */
export function mergeOmcBlock(existing: string, omcContent: string, version?: string): string {
  return mergeClaudeMd(existing, omcContent, version);
}

/**
 * Behavior #13 — `--global --preserve` companion-mode install
 * (bash lines 321-332 + helpers at 203-234, 236-244).
 */
export interface PreserveModeArgs {
  targetPath: string;
  companionPath: string;
  omcContent: string;
  backupDate: string;
  logger?: (line: string) => void;
}

export function installPreserveMode(args: PreserveModeArgs): void {
  const log = args.logger ?? ((line: string) => console.log(line));

  ensureNotSymlinkPath(args.companionPath, 'OMC companion CLAUDE.md');
  ensureNotSymlinkPath(args.targetPath, 'base CLAUDE.md import block');

  if (existsSync(args.companionPath) && args.backupDate) {
    const companionBackup = `${args.companionPath}.backup.${args.backupDate}`;
    copyFileSync(args.companionPath, companionBackup);
    log(`Backed up existing companion CLAUDE.md to ${companionBackup}`);
  }

  writeWrappedOmcFile(args.companionPath, args.omcContent);
  ensureManagedCompanionImport(args.targetPath, COMPANION_FILENAME);

  log('Installed OMC companion file and preserved existing CLAUDE.md');
}

/**
 * Behavior #14 — No-markers migration branch (bash lines 333-351).
 */
export function migrateNoMarkers(existingContent: string, omcContent: string): string {
  let stripped = existingContent;
  if (stripped.includes(IMPORT_START)) {
    const importRegex = new RegExp(
      `^${escapeRegex(IMPORT_START)}\\r?\\n[\\s\\S]*?^${escapeRegex(IMPORT_END)}(?:\\r?\\n)?`,
      'gm',
    );
    stripped = stripped.replace(importRegex, '');
  }
  const body = omcContent.endsWith('\n') ? omcContent : `${omcContent}\n`;
  const tail = stripped.endsWith('\n') ? stripped : `${stripped}\n`;
  return `${START_MARKER}\n${body}${END_MARKER}\n\n${USER_CUSTOMIZATIONS_MIGRATED}\n${tail}`;
}

/**
 * Behavior #15 — Orphaned companion cleanup after overwrite-mode install
 * (bash lines 354-367). Back up then remove `CLAUDE-omc.md` so a later
 * `omc launch` doesn't read stale companion content.
 */
export function cleanupOrphanedCompanion(
  configDir: string,
  backupDate: string,
  opts: { logger?: (line: string) => void } = {},
): void {
  const log = opts.logger ?? ((line: string) => console.log(line));
  const companionPath = join(configDir, COMPANION_FILENAME);
  if (!existsSync(companionPath)) return;
  if (backupDate) {
    copyFileSync(companionPath, `${companionPath}.backup.${backupDate}`);
  }
  unlinkSync(companionPath);
  log('Removed orphaned companion file from prior preserve-mode install');
}

/**
 * Behavior #16 — Post-write marker validation (bash lines 369-372).
 */
export function validatePostWrite(targetPath: string): void {
  const content = readFileSync(targetPath, 'utf8');
  if (!content.includes(START_MARKER) || !content.includes(END_MARKER)) {
    throw new Error(`Installed CLAUDE.md is missing required OMC markers: ${targetPath}`);
  }
}

/**
 * Behavior #19 — Version-change stdout report (bash lines 380-394).
 * BYTE-IDENTICAL format strings — parity test enforces this.
 */
export function reportVersionChange(
  oldVersion: string,
  newVersion: string,
  opts: { logger?: (line: string) => void } = {},
): void {
  const log = opts.logger ?? ((line: string) => console.log(line));
  if (oldVersion === 'none') {
    log(`Installed CLAUDE.md: ${newVersion}`);
  } else if (oldVersion === newVersion) {
    log(`CLAUDE.md unchanged: ${newVersion}`);
  } else {
    log(`Updated CLAUDE.md: ${oldVersion} -> ${newVersion}`);
  }
}

/**
 * Behavior #20 — Legacy hook file cleanup, global mode only
 * (bash lines 396-402).
 */
export function cleanupLegacyHooks(
  configDir: string,
  opts: { logger?: (line: string) => void } = {},
): void {
  const log = opts.logger ?? ((line: string) => console.log(line));
  const legacyHooks = [
    'keyword-detector.sh',
    'stop-continuation.sh',
    'persistent-mode.sh',
    'session-start.sh',
  ];
  for (const name of legacyHooks) {
    const path = join(configDir, 'hooks', name);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
    }
  }
  log('Legacy hooks cleaned');
}

/**
 * Behavior #21 — Warn if legacy hook entries persist in `settings.json`
 * (bash lines 404-413). Byte-identical warning text.
 */
export function warnLegacyHooksInSettings(
  settingsPath: string,
  opts: { logger?: (line: string) => void } = {},
): void {
  const log = opts.logger ?? ((line: string) => console.log(line));
  if (!existsSync(settingsPath)) return;
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return;
  }
  if (settings && typeof settings === 'object' && 'hooks' in (settings as Record<string, unknown>)) {
    log('');
    log('NOTE: Found legacy hooks in settings.json. These should be removed since');
    log('the plugin now provides hooks automatically. Remove the "hooks" section');
    log(`from ${settingsPath} to prevent duplicate hook execution.`);
  }
}

/**
 * Behavior #22 — Final plugin verification message (bash lines 417-421).
 */
export function reportPluginStatus(
  settingsPath: string,
  opts: { logger?: (line: string) => void } = {},
): void {
  const log = opts.logger ?? ((line: string) => console.log(line));
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf8');
      if (content.includes('oh-my-claudecode')) {
        log('Plugin verified');
        return;
      }
    } catch {
      /* fall through to NOT found */
    }
  }
  log('Plugin NOT found - run: claude /install-plugin oh-my-claudecode');
}

// ────────────────────────── top-level entry ──────────────────────────

export interface InstallClaudeMdOptions {
  mode: 'local' | 'global';
  installStyle?: 'overwrite' | 'preserve';
  configDir?: string;
  cwd?: string;
  pluginRoot?: string;
  skipOmcReferenceCopy?: boolean;
  skipGitExclude?: boolean;
  logger?: (line: string) => void;
  /** Override the GitHub fallback URL (test-only). */
  downloadUrl?: string;
  /** Override `fetch` for the GitHub fallback (test-only). */
  fetchImpl?: typeof fetch;
  /** Override `Date.now()` for deterministic backup timestamps (test-only). */
  now?: Date;
}

export interface InstallClaudeMdResult {
  mode: 'local' | 'global';
  installStyle: 'overwrite' | 'preserve';
  targetPath: string;
  skillTargetPath: string;
  companionPath: string;
  validationPath: string;
  oldVersion: string;
  newVersion: string;
  backupPath: string | null;
  backupDate: string;
  sourceLabel: string;
  pluginRoot: string;
}

/**
 * Top-level CLAUDE.md install/merge orchestrator.
 * Ports the entire control flow of `setup-claude-md.sh` (lines 127-421).
 *
 * Sequencing (matches the numbered behaviors 1–22):
 *   1 → resolveActivePluginRoot()
 *   4 → resolveTargetPaths()
 *   5 → type-level install-style validation
 *   6 → extractOldVersion()
 *   7 → backupIfExists()
 *   8 → loadCanonicalOmcContent()
 *   9 → validateOmcMarkers()
 *  10 → stripOmcMarkers()
 *  11 → writeWrappedOmcFile() on fresh install
 *  12 → mergeClaudeMd() on marker-present existing file
 *  13 → installPreserveMode() on global + preserve + no-markers base
 *  14 → migrateNoMarkers() on no-markers existing file
 *  15 → cleanupOrphanedCompanion() after overwrite-mode merge
 *  16 → validatePostWrite()
 *  17 → installOmcReferenceSkill()
 *  18 → ensureLocalOmcGitExclude() for local mode
 *  19 → reportVersionChange()
 *  20 → cleanupLegacyHooks() for global mode
 *  21 → warnLegacyHooksInSettings() for global mode
 *  22 → reportPluginStatus()
 */
export async function installClaudeMd(opts: InstallClaudeMdOptions): Promise<InstallClaudeMdResult> {
  const log = opts.logger ?? ((line: string) => console.log(line));
  const configDir = opts.configDir ?? getClaudeConfigDir();
  const cwd = opts.cwd ?? process.cwd();
  const installStyle = opts.installStyle ?? 'overwrite';
  const mode = opts.mode;

  // Behavior #5 — install-style validation (type-level + runtime guard).
  if (mode !== 'local' && mode !== 'global') {
    throw new Error(`Invalid mode '${mode as string}'. Use 'local' or 'global'.`);
  }
  if (installStyle !== 'overwrite' && installStyle !== 'preserve') {
    throw new Error(`Invalid install style '${installStyle as string}'. Use 'overwrite' or 'preserve'.`);
  }

  // Behavior #1 — resolve active plugin root (with stale-cache guard).
  const pluginRoot = opts.pluginRoot ?? resolveActivePluginRoot({ configDir });

  // Behavior #4 — resolve target paths.
  const paths = resolveTargetPaths(mode, configDir, cwd);
  mkdirSync(dirname(paths.skillTargetPath), { recursive: true });

  // Behavior #6 — extract old version BEFORE any write.
  const oldVersion = extractOldVersion(paths.targetPath);

  // Behavior #7 — backup existing target (no-op if missing).
  const backup = backupIfExists(paths.targetPath, { logger: log, now: opts.now });

  // Behavior #8 — load canonical OMC content.
  const { content: rawOmc, sourceLabel } = await loadCanonicalOmcContent(pluginRoot, {
    downloadUrl: opts.downloadUrl,
    fetchImpl: opts.fetchImpl,
  });

  // Behavior #9 — validate canonical source markers.
  validateOmcMarkers(rawOmc, sourceLabel);

  // Behavior #10 — strip outer markers (keep inner content + version marker).
  const omcContent = stripOmcMarkers(rawOmc);

  let validationPath = paths.targetPath;

  if (!existsSync(paths.targetPath)) {
    // Fresh install — behavior #11.
    writeWrappedOmcFile(paths.targetPath, omcContent);
    log('Installed CLAUDE.md (fresh)');
  } else {
    // Must not overwrite a symlink — regardless of merge branch.
    ensureNotSymlinkPath(paths.targetPath, 'CLAUDE.md');
    const existing = readFileSync(paths.targetPath, 'utf8');

    if (existing.includes(START_MARKER)) {
      // Behavior #12 — marker-aware merge with recovery branch.
      // Extract the canonical version marker so `mergeClaudeMd` can
      // re-inject it at the top of the block (matches the installer's
      // existing contract and keeps H2-unchanged working).
      const canonicalVersion = omcContent.match(OMC_VERSION_REGEX)?.[1];
      const merged = mergeClaudeMd(existing, omcContent, canonicalVersion);
      writeFileSync(paths.targetPath, merged, 'utf8');
      log('Updated OMC section (user customizations preserved)');
    } else if (mode === 'global' && installStyle === 'preserve') {
      // Behavior #13 — preserve mode: write companion + import block.
      installPreserveMode({
        targetPath: paths.targetPath,
        companionPath: paths.companionPath,
        omcContent,
        backupDate: backup.backupDate,
        logger: log,
      });
      validationPath = paths.companionPath;
    } else {
      // Behavior #14 — no-markers migration.
      const migrated = migrateNoMarkers(existing, omcContent);
      writeFileSync(paths.targetPath, migrated, 'utf8');
      log('Migrated existing CLAUDE.md (added OMC markers, preserved old content)');
    }

    // Behavior #15 — orphaned companion cleanup (overwrite mode only).
    if (mode === 'global' && installStyle === 'overwrite') {
      cleanupOrphanedCompanion(configDir, backup.backupDate, { logger: log });
    }
  }

  // Behavior #16 — post-write marker validation.
  validatePostWrite(validationPath);

  // Behavior #17 — install omc-reference skill after main write.
  if (!opts.skipOmcReferenceCopy) {
    const result = installOmcReferenceSkill(paths.skillTargetPath, pluginRoot);
    if (result.installed) {
      log(`Installed omc-reference skill to ${paths.skillTargetPath}`);
    } else if (result.reason === 'canonical source unavailable') {
      log('Skipped omc-reference skill install (canonical skill source unavailable)');
    } else if (result.reason === 'empty canonical source') {
      log(`Skipped omc-reference skill install (empty canonical skill source: ${result.sourceLabel ?? ''})`);
    }
  }

  // Behavior #18 — git exclude, local mode only.
  if (mode === 'local' && !opts.skipGitExclude) {
    ensureLocalOmcGitExclude({ cwd, logger: log });
  }

  // Behavior #19 — extract NEW version (from written file) + report.
  const newVersionExtracted = extractOldVersion(validationPath);
  // `extractOldVersion` returns 'none' only when the file is missing; after
  // a successful write the file exists, so 'none' here means "no marker and
  // no runtime version" → fall back to 'unknown' (matches the bash script's
  // `NEW_VERSION="unknown"` fallback at line 386).
  const newVersion = newVersionExtracted === 'none' ? 'unknown' : newVersionExtracted;
  reportVersionChange(oldVersion, newVersion, { logger: log });

  // Behaviors #20, #21 — legacy hooks cleanup + warning (global only).
  if (mode === 'global') {
    cleanupLegacyHooks(configDir, { logger: log });
    warnLegacyHooksInSettings(join(configDir, 'settings.json'), { logger: log });
  }

  // Behavior #22 — plugin status report.
  reportPluginStatus(join(configDir, 'settings.json'), { logger: log });

  return {
    mode,
    installStyle,
    targetPath: paths.targetPath,
    skillTargetPath: paths.skillTargetPath,
    companionPath: paths.companionPath,
    validationPath,
    oldVersion,
    newVersion,
    backupPath: backup.backupPath,
    backupDate: backup.backupDate,
    sourceLabel,
    pluginRoot,
  };
}
