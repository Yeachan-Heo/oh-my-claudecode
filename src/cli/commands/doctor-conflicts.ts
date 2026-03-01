/**
 * Conflict diagnostic command
 * Scans for and reports plugin coexistence issues.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../../utils/paths.js';
import { isOmcHook } from '../../installer/index.js';
import { colors } from '../utils/formatting.js';
import { listBuiltinSkillNames } from '../../features/builtin-skills/skills.js';

export interface ConflictReport {
  hookConflicts: { event: string; command: string; isOmc: boolean }[];
  claudeMdStatus: { hasMarkers: boolean; hasUserContent: boolean; path: string; companionFile?: string } | null;
  legacySkills: { name: string; path: string }[];
  envFlags: { disableOmc: boolean; skipHooks: string[] };
  configIssues: { unknownFields: string[] };
  hasConflicts: boolean;
}

/**
 * Collect hook entries from a single settings.json file.
 */
function collectHooksFromSettings(settingsPath: string): ConflictReport['hookConflicts'] {
  const conflicts: ConflictReport['hookConflicts'] = [];

  if (!existsSync(settingsPath)) {
    return conflicts;
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks || {};

    // Hook events to check
    const hookEvents = [
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit'
    ];

    for (const event of hookEvents) {
      if (hooks[event] && Array.isArray(hooks[event])) {
        const eventHookGroups = hooks[event] as Array<{ hooks?: Array<{ type?: string; command?: string }> }>;
        for (const group of eventHookGroups) {
          if (!group.hooks || !Array.isArray(group.hooks)) continue;
          for (const hook of group.hooks) {
            if (hook.type === 'command' && hook.command) {
              conflicts.push({ event, command: hook.command, isOmc: isOmcHook(hook.command) });
            }
          }
        }
      }
    }
  } catch (_error) {
    // Ignore parse errors, will be reported separately
  }

  return conflicts;
}

/**
 * Check for hook conflicts in both profile-level (~/.claude/settings.json)
 * and project-level (./.claude/settings.json).
 *
 * Claude Code settings precedence: project > profile > defaults.
 * We check both levels so the diagnostic is complete.
 */
export function checkHookConflicts(): ConflictReport['hookConflicts'] {
  const profileSettingsPath = join(getClaudeConfigDir(), 'settings.json');
  const projectSettingsPath = join(process.cwd(), '.claude', 'settings.json');

  const profileHooks = collectHooksFromSettings(profileSettingsPath);
  const projectHooks = collectHooksFromSettings(projectSettingsPath);

  // Deduplicate by event+command (same hook in both levels should appear once)
  const seen = new Set<string>();
  const merged: ConflictReport['hookConflicts'] = [];

  for (const hook of [...projectHooks, ...profileHooks]) {
    const key = `${hook.event}::${hook.command}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(hook);
    }
  }

  return merged;
}

/**
 * Check a single file for OMC markers.
 * Returns { hasMarkers, hasUserContent } or null on error.
 */
function checkFileForOmcMarkers(filePath: string): { hasMarkers: boolean; hasUserContent: boolean } | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const hasStartMarker = content.includes('<!-- OMC:START -->');
    const hasEndMarker = content.includes('<!-- OMC:END -->');
    const hasMarkers = hasStartMarker && hasEndMarker;

    let hasUserContent = false;
    if (hasMarkers) {
      const startIdx = content.indexOf('<!-- OMC:START -->');
      const endIdx = content.indexOf('<!-- OMC:END -->');
      const beforeMarker = content.substring(0, startIdx).trim();
      const afterMarker = content.substring(endIdx + '<!-- OMC:END -->'.length).trim();
      hasUserContent = beforeMarker.length > 0 || afterMarker.length > 0;
    } else {
      hasUserContent = content.trim().length > 0;
    }
    return { hasMarkers, hasUserContent };
  } catch {
    return null;
  }
}

/**
 * Find companion CLAUDE-*.md files in the config directory.
 * These are files like CLAUDE-omc.md that users create as part of a
 * file-split pattern to keep OMC config separate from their own CLAUDE.md.
 */
function findCompanionClaudeMdFiles(configDir: string): string[] {
  try {
    return readdirSync(configDir)
      .filter(f => /^CLAUDE-.+\.md$/i.test(f))
      .map(f => join(configDir, f));
  } catch {
    return [];
  }
}

/**
 * Check CLAUDE.md for OMC markers and user content.
 * Also checks companion files (CLAUDE-omc.md, etc.) for the file-split pattern
 * where users keep OMC config in a separate file.
 */
export function checkClaudeMdStatus(): ConflictReport['claudeMdStatus'] {
  const configDir = getClaudeConfigDir();
  const claudeMdPath = join(configDir, 'CLAUDE.md');

  if (!existsSync(claudeMdPath)) {
    return null;
  }

  try {
    // Check the main CLAUDE.md first
    const mainResult = checkFileForOmcMarkers(claudeMdPath);
    if (!mainResult) return null;

    if (mainResult.hasMarkers) {
      return {
        hasMarkers: true,
        hasUserContent: mainResult.hasUserContent,
        path: claudeMdPath
      };
    }

    // No markers in main file - check companion files (file-split pattern)
    const companions = findCompanionClaudeMdFiles(configDir);
    for (const companionPath of companions) {
      const companionResult = checkFileForOmcMarkers(companionPath);
      if (companionResult?.hasMarkers) {
        return {
          hasMarkers: true,
          hasUserContent: mainResult.hasUserContent,
          path: claudeMdPath,
          companionFile: companionPath
        };
      }
    }

    // No markers in main or companions - check if CLAUDE.md references a companion
    const content = readFileSync(claudeMdPath, 'utf-8');
    const companionRefPattern = /CLAUDE-[^\s)]+\.md/i;
    const refMatch = content.match(companionRefPattern);
    if (refMatch) {
      // CLAUDE.md references a companion file but it doesn't have markers yet
      return {
        hasMarkers: false,
        hasUserContent: mainResult.hasUserContent,
        path: claudeMdPath,
        companionFile: join(configDir, refMatch[0])
      };
    }

    return {
      hasMarkers: false,
      hasUserContent: mainResult.hasUserContent,
      path: claudeMdPath
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Check environment flags that affect OMC behavior
 */
export function checkEnvFlags(): ConflictReport['envFlags'] {
  const disableOmc = process.env.DISABLE_OMC === 'true' || process.env.DISABLE_OMC === '1';
  const skipHooks: string[] = [];

  if (process.env.OMC_SKIP_HOOKS) {
    skipHooks.push(...process.env.OMC_SKIP_HOOKS.split(',').map(h => h.trim()));
  }

  return { disableOmc, skipHooks };
}

/**
 * Check for legacy curl-installed skills that collide with plugin skill names.
 * Only flags skills whose names match actual installed plugin skills, avoiding
 * false positives for user's custom skills.
 */
export function checkLegacySkills(): ConflictReport['legacySkills'] {
  const legacySkillsDir = join(getClaudeConfigDir(), 'skills');
  if (!existsSync(legacySkillsDir)) return [];

  const collisions: ConflictReport['legacySkills'] = [];
  try {
    const pluginSkillNames = new Set(
      listBuiltinSkillNames({ includeAliases: true }).map(n => n.toLowerCase())
    );
    const entries = readdirSync(legacySkillsDir);
    for (const entry of entries) {
      // Match .md files or directories whose name collides with a plugin skill
      const baseName = entry.replace(/\.md$/i, '').toLowerCase();
      if (pluginSkillNames.has(baseName)) {
        collisions.push({ name: baseName, path: join(legacySkillsDir, entry) });
      }
    }
  } catch {
    // Ignore read errors
  }
  return collisions;
}

/**
 * Check for unknown fields in config files
 */
export function checkConfigIssues(): ConflictReport['configIssues'] {
  const unknownFields: string[] = [];
  const configPath = join(getClaudeConfigDir(), '.omc-config.json');

  if (!existsSync(configPath)) {
    return { unknownFields };
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Known top-level fields from PluginConfig type
    const knownFields = new Set([
      // PluginConfig fields
      'agents',
      'features',
      'mcpServers',
      'permissions',
      'magicKeywords',
      'routing',
      // OMCConfig fields (from auto-update.ts / omc-setup)
      'silentAutoUpdate',
      'configuredAt',
      'configVersion',
      'taskTool',
      'taskToolConfig',
      'defaultExecutionMode',
      'bashHistory',
      'agentTiers',
      'setupCompleted',
      'setupVersion',
      'stopHookCallbacks',
      'notifications',
      'autoUpgradePrompt',
    ]);

    for (const field of Object.keys(config)) {
      if (!knownFields.has(field)) {
        unknownFields.push(field);
      }
    }
  } catch (_error) {
    // Ignore parse errors
  }

  return { unknownFields };
}

/**
 * Run complete conflict check
 */
export function runConflictCheck(): ConflictReport {
  const hookConflicts = checkHookConflicts();
  const claudeMdStatus = checkClaudeMdStatus();
  const legacySkills = checkLegacySkills();
  const envFlags = checkEnvFlags();
  const configIssues = checkConfigIssues();

  // Determine if there are actual conflicts
  const hasConflicts =
    hookConflicts.some(h => !h.isOmc) || // Non-OMC hooks present
    legacySkills.length > 0 || // Legacy skills colliding with plugin
    envFlags.disableOmc || // OMC is disabled
    envFlags.skipHooks.length > 0 || // Hooks are being skipped
    configIssues.unknownFields.length > 0; // Unknown config fields
    // Note: Missing OMC markers is informational (normal for fresh install), not a conflict

  return {
    hookConflicts,
    claudeMdStatus,
    legacySkills,
    envFlags,
    configIssues,
    hasConflicts
  };
}

/**
 * Format report for display
 */
export function formatReport(report: ConflictReport, json: boolean): string {
  if (json) {
    return JSON.stringify(report, null, 2);
  }

  // Human-readable format
  const lines: string[] = [];

  lines.push('');
  lines.push(colors.bold('🔍 Oh-My-ClaudeCode Conflict Diagnostic'));
  lines.push(colors.gray('━'.repeat(60)));
  lines.push('');

  // Hook conflicts
  if (report.hookConflicts.length > 0) {
    lines.push(colors.bold('📌 Hook Configuration'));
    lines.push('');
    for (const hook of report.hookConflicts) {
      const status = hook.isOmc ? colors.green('✓ OMC') : colors.yellow('⚠ Other');
      lines.push(`  ${hook.event.padEnd(20)} ${status}`);
      lines.push(`    ${colors.gray(hook.command)}`);
    }
    lines.push('');
  } else {
    lines.push(colors.bold('📌 Hook Configuration'));
    lines.push(`  ${colors.gray('No hooks configured')}`);
    lines.push('');
  }

  // CLAUDE.md status
  if (report.claudeMdStatus) {
    lines.push(colors.bold('📄 CLAUDE.md Status'));
    lines.push('');

    if (report.claudeMdStatus.hasMarkers) {
      if (report.claudeMdStatus.companionFile) {
        lines.push(`  ${colors.green('✓')} OMC markers found in companion file`);
        lines.push(`    ${colors.gray(`Companion: ${report.claudeMdStatus.companionFile}`)}`);
      } else {
        lines.push(`  ${colors.green('✓')} OMC markers present`);
      }
      if (report.claudeMdStatus.hasUserContent) {
        lines.push(`  ${colors.green('✓')} User content preserved outside markers`);
      }
    } else {
      lines.push(`  ${colors.yellow('⚠')} No OMC markers found`);
      lines.push(`    ${colors.gray('Run /oh-my-claudecode:omc-setup to add markers')}`);
      if (report.claudeMdStatus.hasUserContent) {
        lines.push(`  ${colors.blue('ℹ')} User content present - will be preserved`);
      }
    }
    lines.push(`  ${colors.gray(`Path: ${report.claudeMdStatus.path}`)}`);
    lines.push('');
  } else {
    lines.push(colors.bold('📄 CLAUDE.md Status'));
    lines.push(`  ${colors.gray('No CLAUDE.md found')}`);
    lines.push('');
  }

  // Environment flags
  lines.push(colors.bold('🔧 Environment Flags'));
  lines.push('');
  if (report.envFlags.disableOmc) {
    lines.push(`  ${colors.red('✗')} DISABLE_OMC is set - OMC is disabled`);
  } else {
    lines.push(`  ${colors.green('✓')} DISABLE_OMC not set`);
  }

  if (report.envFlags.skipHooks.length > 0) {
    lines.push(`  ${colors.yellow('⚠')} OMC_SKIP_HOOKS: ${report.envFlags.skipHooks.join(', ')}`);
  } else {
    lines.push(`  ${colors.green('✓')} No hooks are being skipped`);
  }
  lines.push('');

  // Legacy skills
  if (report.legacySkills.length > 0) {
    lines.push(colors.bold('📦 Legacy Skills'));
    lines.push('');
    lines.push(`  ${colors.yellow('⚠')} Skills colliding with plugin skill names:`);
    for (const skill of report.legacySkills) {
      lines.push(`    - ${skill.name} ${colors.gray(`(${skill.path})`)}`);
    }
    lines.push(`    ${colors.gray('These legacy files shadow plugin skills. Remove them or rename to avoid conflicts.')}`);
    lines.push('');
  }

  // Config issues
  if (report.configIssues.unknownFields.length > 0) {
    lines.push(colors.bold('⚙️  Configuration Issues'));
    lines.push('');
    lines.push(`  ${colors.yellow('⚠')} Unknown fields in .omc-config.json:`);
    for (const field of report.configIssues.unknownFields) {
      lines.push(`    - ${field}`);
    }
    lines.push('');
  }

  // Summary
  lines.push(colors.gray('━'.repeat(60)));
  if (report.hasConflicts) {
    lines.push(`${colors.yellow('⚠')} Potential conflicts detected`);
    lines.push(`${colors.gray('Review the issues above and run /oh-my-claudecode:omc-setup if needed')}`);
  } else {
    lines.push(`${colors.green('✓')} No conflicts detected`);
    lines.push(`${colors.gray('OMC is properly configured')}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Doctor conflicts command
 */
export async function doctorConflictsCommand(options: { json?: boolean }): Promise<number> {
  const report = runConflictCheck();
  console.log(formatReport(report, options.json ?? false));
  return report.hasConflicts ? 1 : 0;
}
