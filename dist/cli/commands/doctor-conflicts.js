/**
 * Conflict diagnostic command
 * Scans for and reports plugin coexistence issues.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { isOmcHook } from '../../installer/index.js';
import { analyzeLegacyClaudeMd, decodeClaudeMdUtf8 } from '../../installer/claude-md-analysis.js';
import { colors } from '../utils/formatting.js';
import { getSkillsDir, listBuiltinSkillNames } from '../../features/builtin-skills/skills.js';
import { inspectUnifiedMcpRegistrySync } from '../../installer/mcp-registry.js';
import { findWorkspaceRoot, WORKSPACE_MARKER } from '../../lib/worktree-paths.js';
/**
 * Collect hook entries from a single settings.json file.
 */
function collectHooksFromSettings(settingsPath) {
    const conflicts = [];
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
    catch (_error) {
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
export function checkHookConflicts() {
    const profileSettingsPath = join(getClaudeConfigDir(), 'settings.json');
    const projectSettingsPath = join(process.cwd(), '.claude', 'settings.json');
    const profileHooks = collectHooksFromSettings(profileSettingsPath);
    const projectHooks = collectHooksFromSettings(projectSettingsPath);
    // Deduplicate by event+command (same hook in both levels should appear once)
    const seen = new Set();
    const merged = [];
    for (const hook of [...projectHooks, ...profileHooks]) {
        const key = `${hook.event}::${hook.command}`;
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(hook);
        }
    }
    return merged;
}
function isWindowsUnsafePluginHookCommand(command) {
    return command.includes('find-node.sh')
        || command.includes('/bin/sh')
        || /^sh\s/.test(command);
}
/**
 * Native Windows cannot execute plugin hooks that still route through sh/find-node.
 * Detect stale cache manifests so doctor can point users at setup/update repair
 * instead of reporting a generic hook conflict.
 */
export function checkWindowsUnsafePluginHooks() {
    if (process.platform !== 'win32') {
        return [];
    }
    const roots = [process.env.CLAUDE_PLUGIN_ROOT, ...readInstalledPluginRoots()]
        .filter((root) => typeof root === 'string' && root.length > 0);
    const seenRoots = new Set();
    const unsafe = [];
    for (const pluginRoot of roots) {
        if (seenRoots.has(pluginRoot))
            continue;
        seenRoots.add(pluginRoot);
        const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
        if (!existsSync(hooksJsonPath))
            continue;
        try {
            const parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
            for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
                for (const group of groups) {
                    for (const hook of group.hooks ?? []) {
                        if (hook.type !== 'command' || typeof hook.command !== 'string')
                            continue;
                        if (isWindowsUnsafePluginHookCommand(hook.command)) {
                            unsafe.push({ pluginRoot, event, command: hook.command });
                        }
                    }
                }
            }
        }
        catch {
            // Ignore unreadable manifests; doctor should remain best-effort.
        }
    }
    return unsafe;
}
function hasOutsideUserContent(content, outsideRanges, excludedRanges = []) {
    for (const outside of outsideRanges) {
        let remaining = [outside];
        for (const excluded of excludedRanges) {
            const next = [];
            for (const range of remaining) {
                if (excluded.end <= range.start || excluded.start >= range.end) {
                    next.push(range);
                    continue;
                }
                if (range.start < excluded.start)
                    next.push({ start: range.start, end: excluded.start });
                if (excluded.end < range.end)
                    next.push({ start: excluded.end, end: range.end });
            }
            remaining = next;
        }
        if (remaining.some(range => content.slice(range.start, range.end).trim().length > 0))
            return true;
    }
    return false;
}
function directClaudeMdReferences(content, configDir) {
    const references = new Set();
    for (const line of content.split(/\r?\n/)) {
        if (/^@CLAUDE-[A-Za-z0-9][A-Za-z0-9_-]*\.md$/i.test(line)) {
            references.add(join(configDir, line.slice(1)));
        }
    }
    return [...references].sort();
}
function pathExistsWithoutFollowingSymlinks(filePath) {
    try {
        lstatSync(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function inspectClaudeMdFile(filePath, configDir, isMain) {
    let stats;
    try {
        stats = lstatSync(filePath);
    }
    catch {
        return {
            status: { path: filePath, hasMarkers: false, hasUserContent: false, markerState: 'unreadable', exactLegacy: false, manualReview: false },
            references: []
        };
    }
    if (stats.isSymbolicLink()) {
        return {
            status: { path: filePath, hasMarkers: false, hasUserContent: false, markerState: 'symlink', exactLegacy: false, manualReview: false },
            references: []
        };
    }
    if (!stats.isFile()) {
        return {
            status: { path: filePath, hasMarkers: false, hasUserContent: false, markerState: 'unreadable', exactLegacy: false, manualReview: false },
            references: []
        };
    }
    let bytes;
    try {
        bytes = readFileSync(filePath);
    }
    catch {
        return {
            status: { path: filePath, hasMarkers: false, hasUserContent: false, markerState: 'unreadable', exactLegacy: false, manualReview: false },
            references: []
        };
    }
    let content;
    try {
        content = decodeClaudeMdUtf8(bytes, filePath);
    }
    catch {
        return {
            status: { path: filePath, hasMarkers: false, hasUserContent: false, markerState: 'invalid-utf8', exactLegacy: false, manualReview: false },
            references: []
        };
    }
    const analysis = analyzeLegacyClaudeMd(content);
    const corrupt = analysis.markers.state === 'corrupt';
    return {
        status: {
            path: filePath,
            hasMarkers: analysis.markers.state === 'complete',
            hasUserContent: corrupt
                ? content.trim().length > 0
                : hasOutsideUserContent(content, analysis.markers.outsideRanges, analysis.exactMatches),
            markerState: analysis.markers.state,
            exactLegacy: analysis.exactMatches.length > 0,
            manualReview: corrupt || analysis.manualFindings.length > 0
        },
        references: isMain ? directClaudeMdReferences(content, configDir) : []
    };
}
function genericClaudeMdFiles(configDir) {
    try {
        return readdirSync(configDir)
            .filter(name => /^CLAUDE-.+\.md$/i.test(name) && name.toLowerCase() !== 'claude-omc.md')
            .sort()
            .map(name => join(configDir, name));
    }
    catch {
        return [];
    }
}
/** Analyze main and companion CLAUDE files without following symlinks. */
export function checkClaudeMdStatus() {
    const configDir = getClaudeConfigDir();
    const claudeMdPath = join(configDir, 'CLAUDE.md');
    const activePath = join(configDir, 'CLAUDE-omc.md');
    const genericPaths = genericClaudeMdFiles(configDir);
    const mainExists = pathExistsWithoutFollowingSymlinks(claudeMdPath);
    if (!mainExists && !pathExistsWithoutFollowingSymlinks(activePath) && genericPaths.length === 0)
        return null;
    const main = mainExists ? inspectClaudeMdFile(claudeMdPath, configDir, true) : null;
    const candidatePaths = [...(mainExists ? [claudeMdPath] : []), activePath, ...(main?.references ?? []), ...genericPaths];
    const seen = new Set();
    const files = [];
    for (const filePath of candidatePaths) {
        if (seen.has(filePath))
            continue;
        seen.add(filePath);
        if (filePath !== claudeMdPath && !pathExistsWithoutFollowingSymlinks(filePath))
            continue;
        files.push(filePath === claudeMdPath ? main.status : inspectClaudeMdFile(filePath, configDir, false).status);
    }
    const markerFile = files.find(file => file.hasMarkers);
    const companionFile = markerFile
        ? markerFile.path === claudeMdPath ? undefined : markerFile.path
        : main?.references[0];
    return {
        hasMarkers: markerFile !== undefined,
        hasUserContent: files.some(file => file.hasUserContent),
        path: claudeMdPath,
        companionFile,
        files,
        dirtyFiles: files.filter(file => file.hasUserContent).map(file => file.path),
        exactLegacyPaths: files.filter(file => file.exactLegacy).map(file => file.path),
        manualReviewPaths: files.filter(file => file.manualReview || file.markerState === 'symlink' || file.markerState === 'unreadable' || file.markerState === 'invalid-utf8').map(file => file.path)
    };
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
const SETUP_FALLBACK_SKILL_NAMES = new Set(['omc-reference']);
function parseSemverLikeVersion(version) {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        return null;
    }
    return version.split(/[+-]/, 1)[0].split('.').map(part => Number.parseInt(part, 10));
}
function compareSemverLikeVersions(a, b) {
    const parsedA = parseSemverLikeVersion(a);
    const parsedB = parseSemverLikeVersion(b);
    if (!parsedA || !parsedB) {
        return 0;
    }
    for (let index = 0; index < 3; index += 1) {
        const delta = parsedA[index] - parsedB[index];
        if (delta !== 0) {
            return delta;
        }
    }
    return 0;
}
function isValidSetupPluginRoot(pluginRoot) {
    return existsSync(join(pluginRoot, 'docs', 'CLAUDE.md'));
}
function readInstalledPluginRoots() {
    const installedPluginsPath = join(getClaudeConfigDir(), 'plugins', 'installed_plugins.json');
    if (!existsSync(installedPluginsPath)) {
        return [];
    }
    try {
        const parsed = JSON.parse(readFileSync(installedPluginsPath, 'utf-8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return [];
        }
        const plugins = 'plugins' in parsed
            && parsed.plugins
            && typeof parsed.plugins === 'object'
            && !Array.isArray(parsed.plugins)
            ? parsed.plugins
            : parsed;
        return Object.entries(plugins)
            .filter(([key]) => key.startsWith('oh-my-claudecode'))
            .flatMap(([, value]) => Array.isArray(value) ? value : [])
            .map(entry => entry && typeof entry === 'object' && 'installPath' in entry
            ? entry.installPath
            : null)
            .filter((installPath) => typeof installPath === 'string' && installPath.length > 0);
    }
    catch {
        return [];
    }
}
function findLatestSiblingPluginRoot(pluginRoot) {
    const cacheBase = dirname(pluginRoot);
    if (!existsSync(cacheBase)) {
        return null;
    }
    try {
        return readdirSync(cacheBase)
            .filter(entry => parseSemverLikeVersion(entry))
            .map(entry => join(cacheBase, entry))
            .filter(isValidSetupPluginRoot)
            .sort((a, b) => compareSemverLikeVersions(basename(b), basename(a)))[0] || null;
    }
    catch {
        return null;
    }
}
function getSetupFallbackCanonicalSkillPaths(baseName) {
    const currentSkillsDir = getSkillsDir();
    const currentPluginRoot = dirname(currentSkillsDir);
    const roots = [
        currentPluginRoot,
        process.env.CLAUDE_PLUGIN_ROOT,
        ...readInstalledPluginRoots(),
    ].filter((root) => typeof root === 'string' && root.length > 0);
    for (const root of [...roots]) {
        const latestSibling = findLatestSiblingPluginRoot(root);
        if (latestSibling) {
            roots.push(latestSibling);
        }
    }
    const seen = new Set();
    return [
        join(currentSkillsDir, baseName, 'SKILL.md'),
        ...roots.flatMap(root => [join(root, 'skills', baseName, 'SKILL.md')]),
    ]
        .filter(path => {
        if (seen.has(path)) {
            return false;
        }
        seen.add(path);
        return true;
    });
}
function isSupportedSetupFallbackSkill(legacySkillsDir, entry, baseName) {
    if (!SETUP_FALLBACK_SKILL_NAMES.has(baseName)) {
        return false;
    }
    // scripts/setup-claude-md.sh intentionally syncs the raw bundled
    // skills/omc-reference/SKILL.md file into ~/.claude/skills/omc-reference/SKILL.md
    // as a Claude CLI fallback. Suppress only that exact, unmodified sync so real
    // legacy collisions and user-edited omc-reference copies still surface.
    if (entry.toLowerCase() !== baseName) {
        return false;
    }
    const installedSkillPath = join(legacySkillsDir, entry, 'SKILL.md');
    if (!existsSync(installedSkillPath)) {
        return false;
    }
    try {
        const installedContent = readFileSync(installedSkillPath, 'utf-8');
        return getSetupFallbackCanonicalSkillPaths(baseName).some(canonicalSkillPath => (existsSync(canonicalSkillPath)
            && installedContent === readFileSync(canonicalSkillPath, 'utf-8')));
    }
    catch {
        return false;
    }
}
/**
 * Check for legacy curl-installed skills that collide with plugin skill names.
 * Only flags skills whose names match actual installed plugin skills, avoiding
 * false positives for user's custom skills.
 */
export function checkLegacySkills() {
    const legacySkillsDir = join(getClaudeConfigDir(), 'skills');
    if (!existsSync(legacySkillsDir))
        return [];
    const collisions = [];
    try {
        const pluginSkillNames = new Set(listBuiltinSkillNames({ includeAliases: true }).map(n => n.toLowerCase()));
        const entries = readdirSync(legacySkillsDir);
        for (const entry of entries) {
            // Match .md files or directories whose name collides with a plugin skill
            const baseName = entry.replace(/\.md$/i, '').toLowerCase();
            if (pluginSkillNames.has(baseName)) {
                if (isSupportedSetupFallbackSkill(legacySkillsDir, entry, baseName)) {
                    continue;
                }
                collisions.push({ name: baseName, path: join(legacySkillsDir, entry) });
            }
        }
    }
    catch {
        // Ignore read errors
    }
    return collisions;
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
        // Known top-level fields from the current config surfaces:
        // - PluginConfig (src/shared/types.ts)
        // - OMCConfig (src/features/auto-update.ts)
        // - direct .omc-config.json readers/writers (notifications, auto-invoke,
        //   delegation enforcement, omc-setup team config)
        // - preserved legacy compatibility keys that still appear in user configs
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
            'notificationProfiles',
            'hudEnabled',
            'autoUpgradePrompt',
            'nodeBinary',
            // Direct config readers / writers outside OMCConfig
            'customIntegrations',
            'delegationEnforcementLevel',
            'enforcementLevel',
            'autoInvoke',
            'team',
        ]);
        for (const field of Object.keys(config)) {
            if (!knownFields.has(field)) {
                unknownFields.push(field);
            }
        }
    }
    catch (_error) {
        // Ignore parse errors
    }
    return { unknownFields };
}
/**
 * Check for .omc-workspace marker presence and OMC_STATE_DIR precedence.
 *
 * Reports:
 *  - Whether a .omc-workspace marker was found (and where).
 *  - Whether OMC_STATE_DIR is set.
 *  - When both are set, emits a precedenceConflict flag (OMC_STATE_DIR wins per
 *    the resolution-order principle: OMC_STATE_DIR > .omc-workspace > git > cwd).
 */
export function checkWorkspaceMarker() {
    const markerRoot = findWorkspaceRoot();
    const stateDirEnvValue = process.env.OMC_STATE_DIR && process.env.OMC_STATE_DIR.trim()
        ? process.env.OMC_STATE_DIR.trim()
        : null;
    const stateDirEnvSet = stateDirEnvValue !== null;
    const precedenceConflict = stateDirEnvSet && markerRoot !== null;
    return { markerRoot, stateDirEnvSet, stateDirEnvValue, precedenceConflict };
}
/**
 * Run complete conflict check
 */
export function runConflictCheck() {
    const hookConflicts = checkHookConflicts();
    const claudeMdStatus = checkClaudeMdStatus();
    const legacySkills = checkLegacySkills();
    const envFlags = checkEnvFlags();
    const configIssues = checkConfigIssues();
    const windowsUnsafePluginHooks = checkWindowsUnsafePluginHooks();
    const mcpRegistrySync = inspectUnifiedMcpRegistrySync();
    const workspaceMarker = checkWorkspaceMarker();
    // Determine if there are actual conflicts
    const hasConflicts = hookConflicts.some(h => !h.isOmc) || // Non-OMC hooks present
        legacySkills.length > 0 || // Legacy skills colliding with plugin
        envFlags.disableOmc || // OMC is disabled
        envFlags.skipHooks.length > 0 || // Hooks are being skipped
        configIssues.unknownFields.length > 0 || // Unknown config fields
        windowsUnsafePluginHooks.length > 0 || // Stale plugin hooks still use sh/find-node on Windows
        mcpRegistrySync.claudeMissing.length > 0 ||
        mcpRegistrySync.claudeMismatched.length > 0 ||
        mcpRegistrySync.codexMissing.length > 0 ||
        mcpRegistrySync.codexMismatched.length > 0 ||
        (claudeMdStatus !== null && (claudeMdStatus.exactLegacyPaths.length > 0 || claudeMdStatus.manualReviewPaths.length > 0));
    // Note: Missing OMC markers is informational (normal for fresh install), not a conflict
    // Note: workspaceMarker.precedenceConflict is a WARN, not a hard conflict
    return {
        hookConflicts,
        claudeMdStatus,
        legacySkills,
        envFlags,
        configIssues,
        windowsUnsafePluginHooks,
        mcpRegistrySync,
        workspaceMarker,
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
            if (report.claudeMdStatus.companionFile) {
                lines.push(`  ${colors.green('✓')} OMC markers found in companion file`);
                lines.push(`    ${colors.gray(`Companion: ${report.claudeMdStatus.companionFile}`)}`);
            }
            else {
                lines.push(`  ${colors.green('✓')} OMC markers present`);
            }
            if (report.claudeMdStatus.dirtyFiles.length > 0) {
                lines.push(`  ${colors.green('✓')} User content outside managed ranges: ${report.claudeMdStatus.dirtyFiles.join(', ')}`);
            }
        }
        else {
            lines.push(`  ${colors.yellow('⚠')} No OMC markers found`);
            lines.push(`    ${colors.gray('Run /oh-my-claudecode:omc-setup to add markers to the selected guide')}`);
            if (report.claudeMdStatus.dirtyFiles.length > 0) {
                lines.push(`  ${colors.blue('ℹ')} User content present: ${report.claudeMdStatus.dirtyFiles.join(', ')}`);
            }
        }
        lines.push(`  ${colors.gray(`Path: ${report.claudeMdStatus.path}`)}`);
        if (report.claudeMdStatus.exactLegacyPaths.length > 0) {
            lines.push(`  ${colors.yellow('⚠')} Exact legacy guide content: ${report.claudeMdStatus.exactLegacyPaths.join(', ')}`);
            lines.push(`    ${colors.gray('Run /oh-my-claudecode:omc-setup for coordinator-backed cleanup with a verified backup.')}`);
        }
        if (report.claudeMdStatus.manualReviewPaths.length > 0) {
            lines.push(`  ${colors.yellow('⚠')} Inspection-only review required: ${report.claudeMdStatus.manualReviewPaths.join(', ')}`);
            lines.push(`    ${colors.gray('Manual, corrupt, symlinked, unreadable, or invalid UTF-8 files are never deleted automatically.')}`);
        }
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
    // Windows plugin hook portability
    if (report.windowsUnsafePluginHooks.length > 0) {
        lines.push(colors.bold('🪟 Windows Plugin Hooks'));
        lines.push('');
        lines.push(`  ${colors.yellow('⚠')} Plugin hooks still route through sh/find-node on native Windows:`);
        for (const hook of report.windowsUnsafePluginHooks) {
            lines.push(`    - ${hook.event} ${colors.gray(`(${hook.pluginRoot})`)}`);
            lines.push(`      ${colors.gray(hook.command)}`);
        }
        lines.push(`    ${colors.gray('Run /oh-my-claudecode:omc-setup or update/reinstall the plugin to rewrite hooks to direct node run.cjs commands.')}`);
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
    // Unified MCP registry sync
    lines.push(colors.bold('🧩 Unified MCP Registry'));
    lines.push('');
    if (!report.mcpRegistrySync.registryExists) {
        lines.push(`  ${colors.gray('No unified MCP registry found')}`);
        lines.push(`    ${colors.gray(`Expected path: ${report.mcpRegistrySync.registryPath}`)}`);
    }
    else if (report.mcpRegistrySync.serverNames.length === 0) {
        lines.push(`  ${colors.gray('Registry exists but has no MCP servers')}`);
        lines.push(`    ${colors.gray(`Path: ${report.mcpRegistrySync.registryPath}`)}`);
    }
    else {
        lines.push(`  ${colors.green('✓')} Registry servers: ${report.mcpRegistrySync.serverNames.join(', ')}`);
        lines.push(`    ${colors.gray(`Registry: ${report.mcpRegistrySync.registryPath}`)}`);
        lines.push(`    ${colors.gray(`Claude MCP: ${report.mcpRegistrySync.claudeConfigPath}`)}`);
        lines.push(`    ${colors.gray(`Codex: ${report.mcpRegistrySync.codexConfigPath}`)}`);
        if (report.mcpRegistrySync.claudeMissing.length > 0) {
            lines.push(`  ${colors.yellow('⚠')} Missing from Claude MCP config: ${report.mcpRegistrySync.claudeMissing.join(', ')}`);
        }
        else if (report.mcpRegistrySync.claudeMismatched.length > 0) {
            lines.push(`  ${colors.yellow('⚠')} Mismatched in Claude MCP config: ${report.mcpRegistrySync.claudeMismatched.join(', ')}`);
        }
        else {
            lines.push(`  ${colors.green('✓')} Claude MCP config is in sync`);
        }
        if (report.mcpRegistrySync.codexMissing.length > 0) {
            lines.push(`  ${colors.yellow('⚠')} Missing from Codex config.toml: ${report.mcpRegistrySync.codexMissing.join(', ')}`);
        }
        else if (report.mcpRegistrySync.codexMismatched.length > 0) {
            lines.push(`  ${colors.yellow('⚠')} Mismatched in Codex config.toml: ${report.mcpRegistrySync.codexMismatched.join(', ')}`);
        }
        else {
            lines.push(`  ${colors.green('✓')} Codex config.toml is in sync`);
        }
    }
    lines.push('');
    // Workspace marker
    lines.push(colors.bold('🗂  Workspace Marker (.omc-workspace)'));
    lines.push('');
    const wm = report.workspaceMarker;
    if (wm.markerRoot) {
        lines.push(`  ${colors.green('✓')} ${WORKSPACE_MARKER} found`);
        lines.push(`    ${colors.gray(`Marker root: ${wm.markerRoot}`)}`);
    }
    else {
        lines.push(`  ${colors.gray('ℹ')} No ${WORKSPACE_MARKER} marker found (single-repo mode)`);
    }
    if (wm.stateDirEnvSet) {
        lines.push(`  ${colors.green('✓')} OMC_STATE_DIR is set: ${wm.stateDirEnvValue}`);
    }
    else {
        lines.push(`  ${colors.gray('ℹ')} OMC_STATE_DIR not set`);
    }
    if (wm.precedenceConflict) {
        lines.push(`  ${colors.yellow('⚠')} Both OMC_STATE_DIR and ${WORKSPACE_MARKER} are active.`);
        lines.push(`    ${colors.gray('OMC_STATE_DIR takes precedence (resolution order: OMC_STATE_DIR > .omc-workspace > git > cwd).')}`);
        lines.push(`    ${colors.gray('If you intended .omc-workspace to anchor state, unset OMC_STATE_DIR.')}`);
    }
    lines.push('');
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