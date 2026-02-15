/**
 * Conflict diagnostic command
 * Scans for and reports plugin coexistence issues.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../../utils/paths.js';
import { isOmcHook } from '../../installer/index.js';
import { colors } from '../utils/formatting.js';
/**
 * Check for hook conflicts in ~/.claude/settings.json
 */
export function checkHookConflicts() {
    const conflicts = [];
    const settingsPath = join(getClaudeConfigDir(), 'settings.json');
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
                const eventHookGroups = hooks[event];
                for (const group of eventHookGroups) {
                    if (!group.hooks || !Array.isArray(group.hooks))
                        continue;
                    for (const hook of group.hooks) {
                        if (hook.type === 'command' && hook.command) {
                            conflicts.push({ event, command: hook.command, isOmc: isOmcHook(hook.command) });
                        }
                    }
                }
            }
        }
    }
    catch (error) {
        // Ignore parse errors, will be reported separately
    }
    return conflicts;
}
/**
 * Check CLAUDE.md for OMC markers and user content
 */
export function checkClaudeMdStatus() {
    const claudeMdPath = join(getClaudeConfigDir(), 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
        return null;
    }
    try {
        const content = readFileSync(claudeMdPath, 'utf-8');
        const hasStartMarker = content.includes('<!-- OMC:START -->');
        const hasEndMarker = content.includes('<!-- OMC:END -->');
        const hasMarkers = hasStartMarker && hasEndMarker;
        let hasUserContent = false;
        if (hasMarkers) {
            // Extract content outside markers
            const startIdx = content.indexOf('<!-- OMC:START -->');
            const endIdx = content.indexOf('<!-- OMC:END -->');
            const beforeMarker = content.substring(0, startIdx).trim();
            const afterMarker = content.substring(endIdx + '<!-- OMC:END -->'.length).trim();
            hasUserContent = beforeMarker.length > 0 || afterMarker.length > 0;
        }
        else {
            // No markers means all content is user content
            hasUserContent = content.trim().length > 0;
        }
        return {
            hasMarkers,
            hasUserContent,
            path: claudeMdPath
        };
    }
    catch (error) {
        return null;
    }
}
/**
 * Check environment flags that affect OMC behavior
 */
export function checkEnvFlags() {
    const disableOmc = process.env.DISABLE_OMC === 'true' || process.env.DISABLE_OMC === '1';
    const skipHooks = [];
    if (process.env.OMC_SKIP_HOOKS) {
        skipHooks.push(...process.env.OMC_SKIP_HOOKS.split(',').map(h => h.trim()));
    }
    return { disableOmc, skipHooks };
}
/**
 * Check for unknown fields in config files
 */
export function checkConfigIssues() {
    const unknownFields = [];
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
            'ecomode',
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
    }
    catch (error) {
        // Ignore parse errors
    }
    return { unknownFields };
}
/**
 * Run complete conflict check
 */
export function runConflictCheck() {
    const hookConflicts = checkHookConflicts();
    const claudeMdStatus = checkClaudeMdStatus();
    const envFlags = checkEnvFlags();
    const configIssues = checkConfigIssues();
    // Determine if there are actual conflicts
    const hasConflicts = hookConflicts.some(h => !h.isOmc) || // Non-OMC hooks present
        envFlags.disableOmc || // OMC is disabled
        envFlags.skipHooks.length > 0 || // Hooks are being skipped
        configIssues.unknownFields.length > 0; // Unknown config fields
    // Note: Missing OMC markers is informational (normal for fresh install), not a conflict
    return {
        hookConflicts,
        claudeMdStatus,
        envFlags,
        configIssues,
        hasConflicts
    };
}
/**
 * Format report for display
 */
export function formatReport(report, json) {
    if (json) {
        return JSON.stringify(report, null, 2);
    }
    // Human-readable format
    const lines = [];
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
    }
    else {
        lines.push(colors.bold('📌 Hook Configuration'));
        lines.push(`  ${colors.gray('No hooks configured')}`);
        lines.push('');
    }
    // CLAUDE.md status
    if (report.claudeMdStatus) {
        lines.push(colors.bold('📄 CLAUDE.md Status'));
        lines.push('');
        if (report.claudeMdStatus.hasMarkers) {
            lines.push(`  ${colors.green('✓')} OMC markers present`);
            if (report.claudeMdStatus.hasUserContent) {
                lines.push(`  ${colors.green('✓')} User content preserved outside markers`);
            }
        }
        else {
            lines.push(`  ${colors.yellow('⚠')} No OMC markers found`);
            lines.push(`    ${colors.gray('Run /oh-my-claudecode:omc-setup to add markers')}`);
            if (report.claudeMdStatus.hasUserContent) {
                lines.push(`  ${colors.blue('ℹ')} User content present - will be preserved`);
            }
        }
        lines.push(`  ${colors.gray(`Path: ${report.claudeMdStatus.path}`)}`);
        lines.push('');
    }
    else {
        lines.push(colors.bold('📄 CLAUDE.md Status'));
        lines.push(`  ${colors.gray('No CLAUDE.md found')}`);
        lines.push('');
    }
    // Environment flags
    lines.push(colors.bold('🔧 Environment Flags'));
    lines.push('');
    if (report.envFlags.disableOmc) {
        lines.push(`  ${colors.red('✗')} DISABLE_OMC is set - OMC is disabled`);
    }
    else {
        lines.push(`  ${colors.green('✓')} DISABLE_OMC not set`);
    }
    if (report.envFlags.skipHooks.length > 0) {
        lines.push(`  ${colors.yellow('⚠')} OMC_SKIP_HOOKS: ${report.envFlags.skipHooks.join(', ')}`);
    }
    else {
        lines.push(`  ${colors.green('✓')} No hooks are being skipped`);
    }
    lines.push('');
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
    }
    else {
        lines.push(`${colors.green('✓')} No conflicts detected`);
        lines.push(`${colors.gray('OMC is properly configured')}`);
    }
    lines.push('');
    return lines.join('\n');
}
/**
 * Doctor conflicts command
 */
export async function doctorConflictsCommand(options) {
    const report = runConflictCheck();
    console.log(formatReport(report, options.json ?? false));
    return report.hasConflicts ? 1 : 0;
}
//# sourceMappingURL=doctor-conflicts.js.map