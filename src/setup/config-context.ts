/**
 * Setup config-dir context resolver + wizard banner formatter.
 *
 * Purpose: make `omc setup` CLAUDE_CONFIG_DIR-aware so the user can see
 * exactly which profile the wizard is operating on, and which files it is
 * going to modify, BEFORE they answer Q1 (local vs global).
 *
 * Problem this solves:
 *   A user running multiple Claude Code profiles (e.g. a default and a
 *   `CLAUDE_CONFIG_DIR=~/.claude-personal` profile) previously had no way
 *   to confirm that `omc setup` was targeting the intended profile. The
 *   wizard would jump straight into "Local or Global?" with no context.
 *   If they pick "Global" thinking it means their default profile, but
 *   CLAUDE_CONFIG_DIR is actually set to a different directory, they
 *   would silently overwrite the wrong CLAUDE.md.
 *
 * Design:
 *   - `resolveConfigContext(opts)` computes the effective `configDir`
 *     (honouring CLAUDE_CONFIG_DIR) plus the concrete list of files that
 *     would be touched for each target (local / global).
 *   - `formatConfigBanner(ctx)` returns a multi-line string to print at
 *     the top of the wizard (before Q1) so the user can see the profile
 *     + file list at a glance.
 *   - `describeTargetOption(ctx, kind)` returns a one-line description
 *     that replaces the static description text in the `target` question
 *     with paths resolved against the actual configDir/cwd.
 *
 * Non-goals:
 *   - This module does NOT resolve plugin roots (see plugin-root.ts).
 *   - It does NOT enumerate every file `install()` might touch — only
 *     the files that are load-bearing for the "which profile am I
 *     configuring?" question (CLAUDE.md, .omc-config.json, settings.json,
 *     and the companion CLAUDE-omc.md that `--preserve` writes).
 */

import { join } from 'path';
import { getClaudeConfigDir } from '../utils/config-dir.js';

export interface ConfigContextOptions {
  /** Override the current working directory (tests). */
  cwd?: string;
  /**
   * Override the resolved config dir (tests / direct injection). If
   * unset, `getClaudeConfigDir()` is called which honours
   * `CLAUDE_CONFIG_DIR` from the process environment.
   */
  configDir?: string;
  /** Override the raw `CLAUDE_CONFIG_DIR` env value used for reporting. */
  envVarValue?: string | undefined;
}

export interface ConfigContext {
  /** Absolute path to the effective Claude Code config directory. */
  configDir: string;
  /** `true` when `CLAUDE_CONFIG_DIR` is NOT set (i.e. using `~/.claude`). */
  isDefault: boolean;
  /** `true` when `CLAUDE_CONFIG_DIR` was set (even if empty after trim). */
  envVarSet: boolean;
  /** Raw `CLAUDE_CONFIG_DIR` value as set by the user, or `undefined`. */
  envVarValue: string | undefined;
  /** Absolute path to the current working directory (local target parent). */
  projectDir: string;
  /** Files that would be written/merged when the user picks "Local". */
  localFiles: string[];
  /** Files that would be written/merged when the user picks "Global". */
  globalFiles: string[];
  /**
   * Files that would be written when the user picks "Global" AND
   * selects `--preserve` / "Keep base CLAUDE.md" in the second question.
   * Differs from `globalFiles` by one entry: the companion file.
   */
  globalFilesPreserve: string[];
}

/**
 * Resolve the config context for the current invocation.
 *
 * By default reads `CLAUDE_CONFIG_DIR` from `process.env` via
 * `getClaudeConfigDir()`. Tests should pass explicit overrides via
 * `opts.configDir` / `opts.envVarValue` / `opts.cwd` rather than mutating
 * `process.env` so the resolver stays a pure function.
 */
export function resolveConfigContext(
  opts: ConfigContextOptions = {},
): ConfigContext {
  const configDir = opts.configDir ?? getClaudeConfigDir();
  const cwd = opts.cwd ?? process.cwd();

  // envVarValue: if caller passed one explicitly (including `undefined`
  // via `envVarValue: undefined`), respect it. Otherwise read from env.
  const envVarValue = 'envVarValue' in opts
    ? opts.envVarValue
    : process.env.CLAUDE_CONFIG_DIR?.trim();
  const envVarSet = envVarValue !== undefined && envVarValue.length > 0;
  const isDefault = !envVarSet;

  // Local target = project-scoped: writes under `<cwd>/.claude/`.
  // See src/setup/claude-md.ts::resolveTargetPaths (local branch).
  const localClaudeMd = join(cwd, '.claude', 'CLAUDE.md');
  const localGitExclude = join(cwd, '.git', 'info', 'exclude');
  const localOmcReferenceSkill = join(
    cwd,
    '.claude',
    'skills',
    'omc-reference',
    'SKILL.md',
  );

  // Global target = profile-wide: writes under `<configDir>/`.
  const globalClaudeMd = join(configDir, 'CLAUDE.md');
  const globalOmcConfig = join(configDir, '.omc-config.json');
  const globalSettings = join(configDir, 'settings.json');
  const globalCompanion = join(configDir, 'CLAUDE-omc.md');

  const localFiles = [localClaudeMd, localGitExclude, localOmcReferenceSkill];
  const globalFiles = [globalClaudeMd, globalOmcConfig, globalSettings];
  const globalFilesPreserve = [...globalFiles, globalCompanion];

  return {
    configDir,
    isDefault,
    envVarSet,
    envVarValue,
    projectDir: cwd,
    localFiles,
    globalFiles,
    globalFilesPreserve,
  };
}

/**
 * Format the pre-wizard banner. Printed to the prompter's `write()`
 * sink before the first question so the user can confirm the profile.
 *
 * Example output (CLAUDE_CONFIG_DIR set):
 *
 *   ━━━ omc setup ━━━
 *   Config profile: /Users/peter/.claude-personal  (from CLAUDE_CONFIG_DIR)
 *   Project dir:    /Users/peter/_Git/_Claude/oh-my-claudecode
 *
 *   Files that will be modified depending on your answer to Q1:
 *
 *     If you pick LOCAL (this project):
 *       - /Users/peter/_Git/_Claude/oh-my-claudecode/.claude/CLAUDE.md
 *       - /Users/peter/_Git/_Claude/oh-my-claudecode/.git/info/exclude
 *       - /Users/peter/_Git/_Claude/oh-my-claudecode/.claude/skills/omc-reference/SKILL.md
 *
 *     If you pick GLOBAL (all projects in this profile):
 *       - /Users/peter/.claude-personal/CLAUDE.md
 *       - /Users/peter/.claude-personal/.omc-config.json
 *       - /Users/peter/.claude-personal/settings.json
 *       (+ /Users/peter/.claude-personal/CLAUDE-omc.md in --preserve mode)
 *
 *   Ctrl-C to abort if this is the wrong profile.
 *   ━━━━━━━━━━━━━━━━
 */
export function formatConfigBanner(ctx: ConfigContext): string {
  const lines: string[] = [];
  lines.push('━━━ omc setup ━━━');

  const profileSuffix = ctx.envVarSet
    ? '  (from CLAUDE_CONFIG_DIR)'
    : '  (default — CLAUDE_CONFIG_DIR not set)';
  lines.push(`Config profile: ${ctx.configDir}${profileSuffix}`);
  lines.push(`Project dir:    ${ctx.projectDir}`);
  lines.push('');
  lines.push('Files that will be modified depending on your answer to Q1:');
  lines.push('');
  lines.push('  If you pick LOCAL (this project):');
  for (const f of ctx.localFiles) {
    lines.push(`    - ${f}`);
  }
  lines.push('');
  lines.push('  If you pick GLOBAL (all projects in this profile):');
  for (const f of ctx.globalFiles) {
    lines.push(`    - ${f}`);
  }
  // The companion file is only added when the user picks --preserve in Q2.
  // Show it parenthetically so users realise a second file may be written.
  const companion = ctx.globalFilesPreserve.find(
    (f) => !ctx.globalFiles.includes(f),
  );
  if (companion !== undefined) {
    lines.push(`    (+ ${companion} in --preserve mode)`);
  }
  lines.push('');
  lines.push('Ctrl-C to abort if this is the wrong profile.');
  lines.push('━━━━━━━━━━━━━━━━');
  // Trailing newline so the first question starts on a fresh line.
  lines.push('');
  return lines.join('\n');
}

/**
 * Describe the "Local" or "Global" option in the Q1 (target) question
 * using paths resolved against the active config context. Returned
 * string replaces the static description text in QUESTION_METADATA
 * when the wizard renders the options so the user sees a concrete
 * absolute path next to each choice, not just a vague "in current
 * project directory" / "for all Claude Code sessions" description.
 */
export function describeTargetOption(
  ctx: ConfigContext,
  kind: 'local' | 'global',
): string {
  if (kind === 'local') {
    const path = ctx.localFiles[0];
    return `Creates ${path} — project-scoped.`;
  }
  const path = ctx.globalFiles[0];
  const profileHint = ctx.envVarSet
    ? ` (CLAUDE_CONFIG_DIR profile: ${ctx.configDir})`
    : '';
  return `Creates ${path}${profileHint} — applies to all Claude Code sessions in this profile.`;
}
