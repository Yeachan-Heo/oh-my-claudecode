/**
 * Auto-Update System
 *
 * Provides version checking and auto-update functionality for oh-my-claudecode.
 *
 * Features:
 * - Check for new versions from GitHub releases
 * - Download and install updates automatically
 * - Store version metadata for installed components
 * - Configurable update notifications
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { execSync, execFileSync } from 'child_process';
import { install as installOmc, HOOKS_DIR, isProjectScopedPlugin, isRunningAsPlugin, getInstalledOmcPluginRoots, getRuntimePackageRoot, } from '../installer/index.js';
import { getClaudeConfigDir } from '../utils/config-dir.js';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';
import { isAutoUpdateDisabled } from '../lib/security-config.js';
/** GitHub repository information */
export const REPO_OWNER = 'Yeachan-Heo';
export const REPO_NAME = 'oh-my-claudecode';
export const GITHUB_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
export const GITHUB_RAW_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}`;
/**
 * Best-effort sync of the Claude Code marketplace clone.
 * The marketplace clone at ~/.claude/plugins/marketplaces/omc/ is used by
 * Claude Code to populate the plugin cache. If it's stale, `/plugin install`
 * and cache rebuilds reinstall old versions. (See #506)
 */
function syncMarketplaceClone(verbose = false) {
    const marketplacePath = join(getClaudeConfigDir(), 'plugins', 'marketplaces', 'omc');
    if (!existsSync(marketplacePath)) {
        return { ok: true, message: 'Marketplace clone not found; skipping' };
    }
    const stdio = verbose ? 'inherit' : 'pipe';
    const execOpts = { encoding: 'utf-8', stdio: stdio, timeout: 60000 };
    const queryExecOpts = { encoding: 'utf-8', stdio: 'pipe', timeout: 60000 };
    try {
        execFileSync('git', ['-C', marketplacePath, 'fetch', '--all', '--prune'], execOpts);
    }
    catch (err) {
        return { ok: false, message: `Failed to fetch marketplace clone: ${err instanceof Error ? err.message : err}` };
    }
    try {
        execFileSync('git', ['-C', marketplacePath, 'checkout', 'main'], { ...execOpts, timeout: 15000 });
    }
    catch {
        // Fall through to explicit branch verification below.
    }
    let currentBranch = '';
    try {
        currentBranch = String(execFileSync('git', ['-C', marketplacePath, 'rev-parse', '--abbrev-ref', 'HEAD'], queryExecOpts) ?? '').trim();
    }
    catch (err) {
        return { ok: false, message: `Failed to inspect marketplace clone branch: ${err instanceof Error ? err.message : err}` };
    }
    if (currentBranch !== 'main') {
        return {
            ok: false,
            message: `Skipped marketplace clone update: expected branch main but found ${currentBranch || 'unknown'}`,
        };
    }
    let statusOutput = '';
    try {
        statusOutput = String(execFileSync('git', ['-C', marketplacePath, 'status', '--porcelain', '--untracked-files=normal'], queryExecOpts) ?? '').trim();
    }
    catch (err) {
        return { ok: false, message: `Failed to inspect marketplace clone status: ${err instanceof Error ? err.message : err}` };
    }
    if (statusOutput.length > 0) {
        return {
            ok: false,
            message: 'Skipped marketplace clone update: repo has local modifications; commit, stash, or clean it first',
        };
    }
    let aheadCount = 0;
    let behindCount = 0;
    try {
        const revListOutput = String(execFileSync('git', ['-C', marketplacePath, 'rev-list', '--left-right', '--count', 'HEAD...origin/main'], queryExecOpts) ?? '').trim();
        const [aheadRaw = '0', behindRaw = '0'] = revListOutput.split(/\s+/);
        aheadCount = Number.parseInt(aheadRaw, 10) || 0;
        behindCount = Number.parseInt(behindRaw, 10) || 0;
    }
    catch (err) {
        return { ok: false, message: `Failed to inspect marketplace clone divergence: ${err instanceof Error ? err.message : err}` };
    }
    if (aheadCount > 0) {
        return {
            ok: false,
            message: 'Skipped marketplace clone update: repo has local commits on main; manual reconciliation required',
        };
    }
    if (behindCount === 0) {
        return { ok: true, message: 'Marketplace clone already up to date' };
    }
    try {
        execFileSync('git', ['-C', marketplacePath, 'merge', '--ff-only', 'origin/main'], execOpts);
    }
    catch (err) {
        return { ok: false, message: `Failed to fast-forward marketplace clone: ${err instanceof Error ? err.message : err}` };
    }
    return { ok: true, message: 'Marketplace clone updated' };
}
const PLUGIN_SYNC_PAYLOAD = [
    'dist',
    'bridge',
    'hooks',
    'scripts',
    'skills',
    'agents',
    'templates',
    'docs',
    '.claude-plugin',
    '.mcp.json',
    'README.md',
    'LICENSE',
    'package.json',
];
function copyPluginSyncPayload(sourceRoot, targetRoots) {
    if (targetRoots.length === 0) {
        return { synced: false, errors: [] };
    }
    let synced = false;
    const errors = [];
    for (const targetRoot of targetRoots) {
        let copiedToTarget = false;
        for (const entry of PLUGIN_SYNC_PAYLOAD) {
            const sourcePath = join(sourceRoot, entry);
            if (!existsSync(sourcePath)) {
                continue;
            }
            try {
                cpSync(sourcePath, join(targetRoot, entry), {
                    recursive: true,
                    force: true,
                });
                copiedToTarget = true;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`Failed to sync ${entry} to ${targetRoot}: ${message}`);
            }
        }
        synced = synced || copiedToTarget;
    }
    return { synced, errors };
}
function syncActivePluginCache() {
    const activeRoots = getInstalledOmcPluginRoots().filter(root => existsSync(root));
    if (activeRoots.length === 0) {
        return { synced: false, errors: [] };
    }
    const result = copyPluginSyncPayload(getRuntimePackageRoot(), activeRoots);
    if (result.synced) {
        console.log('[omc update] Synced plugin cache');
    }
    return result;
}
export function shouldBlockStandaloneUpdateInCurrentSession() {
    if (!isRunningAsPlugin()) {
        return false;
    }
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT?.trim();
    if (entrypoint) {
        return true;
    }
    const sessionId = process.env.CLAUDE_SESSION_ID?.trim() || process.env.CLAUDECODE_SESSION_ID?.trim();
    if (sessionId) {
        return true;
    }
    return false;
}
export function syncPluginCache(verbose = false) {
    const pluginCacheRoot = join(getClaudeConfigDir(), 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    if (!existsSync(pluginCacheRoot)) {
        return { synced: false, skipped: true, errors: [] };
    }
    try {
        const npmRoot = String(execSync('npm root -g', {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 10000,
            ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        }) ?? '').trim();
        if (!npmRoot) {
            throw new Error('npm root -g returned an empty path');
        }
        const sourceRoot = join(npmRoot, 'oh-my-claude-sisyphus');
        const packageJsonPath = join(sourceRoot, 'package.json');
        const packageJsonRaw = String(readFileSync(packageJsonPath, 'utf-8') ?? '');
        const packageMetadata = JSON.parse(packageJsonRaw);
        const version = typeof packageMetadata.version === 'string' ? packageMetadata.version.trim() : '';
        if (!version) {
            throw new Error(`Missing version in ${packageJsonPath}`);
        }
        const versionedPluginCacheRoot = join(pluginCacheRoot, version);
        mkdirSync(versionedPluginCacheRoot, { recursive: true });
        const result = copyPluginSyncPayload(sourceRoot, [versionedPluginCacheRoot]);
        if (result.errors.length > 0) {
            for (const error of result.errors) {
                console.warn(`[omc update] Plugin cache sync warning: ${error}`);
            }
        }
        if (result.synced) {
            console.log('[omc update] Plugin cache synced');
        }
        return { ...result, skipped: false };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (verbose) {
            console.warn(`[omc update] Plugin cache sync warning: ${message}`);
        }
        else {
            console.warn('[omc update] Plugin cache sync warning:', message);
        }
        return { synced: false, skipped: false, errors: [message] };
    }
}
/** Installation paths (respects CLAUDE_CONFIG_DIR env var) */
export const CLAUDE_CONFIG_DIR = getClaudeConfigDir();
export const VERSION_FILE = join(CLAUDE_CONFIG_DIR, '.omc-version.json');
export const CONFIG_FILE = join(CLAUDE_CONFIG_DIR, '.omc-config.json');
/**
 * Read the OMC configuration
 */
export function getOMCConfig() {
    if (!existsSync(CONFIG_FILE)) {
        // No config file = disabled by default for security
        return { silentAutoUpdate: false };
    }
    try {
        const content = readFileSync(CONFIG_FILE, 'utf-8');
        const config = JSON.parse(content);
        return {
            silentAutoUpdate: config.silentAutoUpdate ?? false,
            configuredAt: config.configuredAt,
            configVersion: config.configVersion,
            taskTool: config.taskTool,
            taskToolConfig: config.taskToolConfig,
            setupCompleted: config.setupCompleted,
            setupVersion: config.setupVersion,
            stopHookCallbacks: config.stopHookCallbacks,
            notifications: config.notifications,
            notificationProfiles: config.notificationProfiles,
            hudEnabled: config.hudEnabled,
            autoUpgradePrompt: config.autoUpgradePrompt,
            nodeBinary: config.nodeBinary,
        };
    }
    catch {
        // If config file is invalid, default to disabled for security
        return { silentAutoUpdate: false };
    }
}
/**
 * Check if silent auto-updates are enabled
 */
export function isSilentAutoUpdateEnabled() {
    if (isAutoUpdateDisabled())
        return false;
    return getOMCConfig().silentAutoUpdate;
}
/**
 * Check if auto-upgrade prompt is enabled at session start
 * Returns true by default - users must explicitly opt out
 */
export function isAutoUpgradePromptEnabled() {
    return getOMCConfig().autoUpgradePrompt !== false;
}
/**
 * Check if team feature is enabled
 * Returns false by default - requires explicit opt-in
 * Checks ~/.claude/settings.json first, then env var fallback
 */
export function isTeamEnabled() {
    try {
        const settingsPath = join(CLAUDE_CONFIG_DIR, 'settings.json');
        if (existsSync(settingsPath)) {
            const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
            const val = settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
            if (val === '1' || val === 'true') {
                return true;
            }
        }
    }
    catch {
        // Fall through to env check
    }
    const envVal = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    return envVal === '1' || envVal === 'true';
}
/**
 * Read the current version metadata
 */
export function getInstalledVersion() {
    if (!existsSync(VERSION_FILE)) {
        // Try to detect version from package.json if installed via npm
        try {
            // Check if we can find the package in node_modules
            const result = execSync('npm list -g oh-my-claude-sisyphus --json', {
                encoding: 'utf-8',
                timeout: 5000,
                stdio: 'pipe'
            });
            const data = JSON.parse(result);
            if (data.dependencies?.['oh-my-claude-sisyphus']?.version) {
                return {
                    version: data.dependencies['oh-my-claude-sisyphus'].version,
                    installedAt: new Date().toISOString(),
                    installMethod: 'npm'
                };
            }
        }
        catch {
            // Not installed via npm or command failed
        }
        return null;
    }
    try {
        const content = readFileSync(VERSION_FILE, 'utf-8');
        return JSON.parse(content);
    }
    catch (error) {
        console.error('Error reading version file:', error);
        return null;
    }
}
/**
 * Save version metadata after installation/update
 */
export function saveVersionMetadata(metadata) {
    const dir = dirname(VERSION_FILE);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(VERSION_FILE, JSON.stringify(metadata, null, 2));
}
/**
 * Update the last check timestamp
 */
export function updateLastCheckTime() {
    const current = getInstalledVersion();
    if (current) {
        current.lastCheckAt = new Date().toISOString();
        saveVersionMetadata(current);
    }
}
/**
 * Fetch the latest release from GitHub
 */
export async function fetchLatestRelease() {
    const response = await fetch(`${GITHUB_API_URL}/releases/latest`, {
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'oh-my-claudecode-updater'
        }
    });
    if (response.status === 404) {
        // No releases found - try to get version from package.json in repo
        const pkgResponse = await fetch(`${GITHUB_RAW_URL}/main/package.json`, {
            headers: {
                'User-Agent': 'oh-my-claudecode-updater'
            }
        });
        if (pkgResponse.ok) {
            const pkg = await pkgResponse.json();
            return {
                tag_name: `v${pkg.version}`,
                name: `Version ${pkg.version}`,
                published_at: new Date().toISOString(),
                html_url: `https://github.com/${REPO_OWNER}/${REPO_NAME}`,
                body: 'No release notes available (fetched from package.json)',
                prerelease: false,
                draft: false
            };
        }
        throw new Error('No releases found and could not fetch package.json');
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch release info: ${response.status} ${response.statusText}`);
    }
    return await response.json();
}
/**
 * Compare semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a, b) {
    // Remove 'v' prefix if present
    const cleanA = a.replace(/^v/, '');
    const cleanB = b.replace(/^v/, '');
    const partsA = cleanA.split('.').map(n => parseInt(n, 10) || 0);
    const partsB = cleanB.split('.').map(n => parseInt(n, 10) || 0);
    const maxLength = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < maxLength; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA < numB)
            return -1;
        if (numA > numB)
            return 1;
    }
    return 0;
}
/**
 * Check for available updates
 */
export async function checkForUpdates() {
    const installed = getInstalledVersion();
    const release = await fetchLatestRelease();
    const currentVersion = installed?.version ?? null;
    const latestVersion = release.tag_name.replace(/^v/, '');
    const updateAvailable = currentVersion === null || compareVersions(currentVersion, latestVersion) < 0;
    // Update last check time
    updateLastCheckTime();
    return {
        currentVersion,
        latestVersion,
        updateAvailable,
        releaseInfo: release,
        releaseNotes: release.body || 'No release notes available.'
    };
}
/**
 * Reconcile runtime state after update
 *
 * This is safe to run repeatedly and refreshes local runtime artifacts that may
 * lag behind an updated package or plugin cache.
 */
export function reconcileUpdateRuntime(options) {
    const errors = [];
    const runningAsPlugin = isRunningAsPlugin();
    const projectScopedPlugin = isProjectScopedPlugin();
    const shouldRefreshPluginHooks = runningAsPlugin && !projectScopedPlugin;
    if (!projectScopedPlugin) {
        try {
            if (!existsSync(HOOKS_DIR)) {
                mkdirSync(HOOKS_DIR, { recursive: true });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Failed to prepare hooks directory: ${message}`);
        }
    }
    try {
        const installResult = installOmc({
            force: true,
            verbose: options?.verbose ?? false,
            skipClaudeCheck: true,
            forceHooks: shouldRefreshPluginHooks,
            refreshHooksInPlugin: shouldRefreshPluginHooks,
        });
        if (!installResult.success) {
            errors.push(...installResult.errors);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to refresh installer artifacts: ${message}`);
    }
    try {
        const pluginSyncResult = syncActivePluginCache();
        if (pluginSyncResult.errors.length > 0 && options?.verbose) {
            for (const err of pluginSyncResult.errors) {
                console.warn(`[omc] Plugin cache sync warning: ${err}`);
            }
        }
    }
    catch (error) {
        if (options?.verbose) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[omc] Plugin cache sync warning: ${message}`);
        }
    }
    // Purge stale plugin cache versions (non-fatal)
    try {
        const purgeResult = purgeStalePluginCacheVersions({ skipGracePeriod: options?.skipGracePeriod });
        if (purgeResult.removed > 0 && options?.verbose) {
            console.log(`[omc] Purged ${purgeResult.removed} stale plugin cache version(s)`);
        }
        if (purgeResult.errors.length > 0 && options?.verbose) {
            for (const err of purgeResult.errors) {
                console.warn(`[omc] Cache purge warning: ${err}`);
            }
        }
    }
    catch {
        // Cache purge is best-effort; never block reconciliation
    }
    if (errors.length > 0) {
        return {
            success: false,
            message: 'Runtime reconciliation failed',
            errors,
        };
    }
    return {
        success: true,
        message: 'Runtime state reconciled successfully',
    };
}
function getFirstResolvedBinaryPath(output) {
    const resolved = output
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
    if (!resolved) {
        throw new Error('Unable to resolve omc binary path for update reconciliation');
    }
    return resolved;
}
function resolveOmcBinaryPath() {
    if (process.platform === 'win32') {
        return getFirstResolvedBinaryPath(execFileSync('where.exe', ['omc.cmd'], {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5000,
            windowsHide: true,
        }));
    }
    return getFirstResolvedBinaryPath(execSync('which omc 2>/dev/null || where omc 2>NUL', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
    }));
}
/**
 * Download and execute the install script to perform an update
 */
export async function performUpdate(options) {
    const installed = getInstalledVersion();
    const previousVersion = installed?.version ?? null;
    try {
        // Block npm update only from active Claude Code/plugin sessions.
        // Standalone terminals may inherit CLAUDE_PLUGIN_ROOT and should still update.
        if (shouldBlockStandaloneUpdateInCurrentSession() && !options?.standalone) {
            return {
                success: false,
                previousVersion,
                newVersion: 'unknown',
                message: 'Running inside an active Claude Code plugin session. Use "/plugin install oh-my-claudecode" to update, or pass --standalone to force npm update.',
            };
        }
        // Fetch the latest release to get the version
        const release = await fetchLatestRelease();
        const newVersion = release.tag_name.replace(/^v/, '');
        // Use npm for updates on all platforms (install.sh was removed)
        try {
            execSync('npm install -g oh-my-claude-sisyphus@latest', {
                encoding: 'utf-8',
                stdio: options?.verbose ? 'inherit' : 'pipe',
                timeout: 120000, // 2 minute timeout for npm
                ...(process.platform === 'win32' ? { windowsHide: true } : {})
            });
            // Sync Claude Code marketplace clone so plugin cache picks up new version (#506)
            const marketplaceSync = syncMarketplaceClone(options?.verbose ?? false);
            if (!marketplaceSync.ok && options?.verbose) {
                console.warn(`[omc update] ${marketplaceSync.message}`);
            }
            syncPluginCache(options?.verbose ?? false);
            // CRITICAL FIX: After npm updates the global package, the current process
            // still has OLD code loaded in memory. We must re-exec to run reconciliation
            // with the NEW code. Otherwise, installOmc() runs OLD logic against NEW files.
            if (!process.env.OMC_UPDATE_RECONCILE) {
                // Set flag to prevent infinite loop
                process.env.OMC_UPDATE_RECONCILE = '1';
                // Find the omc binary path
                const omcPath = resolveOmcBinaryPath();
                // Re-exec with reconcile subcommand
                try {
                    execFileSync(omcPath, ['update-reconcile', ...(options?.clean ? ['--skip-grace-period'] : [])], {
                        encoding: 'utf-8',
                        stdio: options?.verbose ? 'inherit' : 'pipe',
                        timeout: 60000,
                        env: { ...process.env, OMC_UPDATE_RECONCILE: '1' },
                        ...(process.platform === 'win32' ? { windowsHide: true, shell: true } : {}),
                    });
                }
                catch (reconcileError) {
                    return {
                        success: false,
                        previousVersion,
                        newVersion,
                        message: `Updated to ${newVersion}, but runtime reconciliation failed`,
                        errors: [reconcileError instanceof Error ? reconcileError.message : String(reconcileError)],
                    };
                }
                // Update version metadata after reconciliation succeeds
                saveVersionMetadata({
                    version: newVersion,
                    installedAt: new Date().toISOString(),
                    installMethod: 'npm',
                    lastCheckAt: new Date().toISOString()
                });
                return {
                    success: true,
                    previousVersion,
                    newVersion,
                    message: `Successfully updated from ${previousVersion ?? 'unknown'} to ${newVersion}`
                };
            }
            else {
                // We're in the re-exec'd process - run reconciliation directly
                const reconcileResult = reconcileUpdateRuntime({ verbose: options?.verbose, skipGracePeriod: options?.clean });
                if (!reconcileResult.success) {
                    return {
                        success: false,
                        previousVersion,
                        newVersion,
                        message: `Updated to ${newVersion}, but runtime reconciliation failed`,
                        errors: reconcileResult.errors?.map(e => `Reconciliation failed: ${e}`),
                    };
                }
                return {
                    success: true,
                    previousVersion,
                    newVersion,
                    message: 'Reconciliation completed successfully'
                };
            }
        }
        catch (npmError) {
            throw new Error('Auto-update via npm failed. Please run manually:\n' +
                '  npm install -g oh-my-claude-sisyphus@latest\n' +
                'Or use: /plugin install oh-my-claudecode\n' +
                `Error: ${npmError instanceof Error ? npmError.message : npmError}`);
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            previousVersion,
            newVersion: 'unknown',
            message: `Update failed: ${errorMessage}`,
            errors: [errorMessage]
        };
    }
}
/**
 * Get a formatted update notification message
 */
export function formatUpdateNotification(checkResult) {
    if (!checkResult.updateAvailable) {
        return `oh-my-claudecode is up to date (v${checkResult.currentVersion ?? 'unknown'})`;
    }
    const lines = [
        '╔═══════════════════════════════════════════════════════════╗',
        '║           oh-my-claudecode Update Available!              ║',
        '╚═══════════════════════════════════════════════════════════╝',
        '',
        `  Current version: ${checkResult.currentVersion ?? 'unknown'}`,
        `  Latest version:  ${checkResult.latestVersion}`,
        '',
        '  To update, run: /update',
        '  Or reinstall via: /plugin install oh-my-claudecode',
        ''
    ];
    // Add truncated release notes if available
    if (checkResult.releaseNotes && checkResult.releaseNotes !== 'No release notes available.') {
        lines.push('  Release notes:');
        const notes = checkResult.releaseNotes.split('\n').slice(0, 5);
        notes.forEach(line => lines.push(`    ${line}`));
        if (checkResult.releaseNotes.split('\n').length > 5) {
            lines.push('    ...');
        }
        lines.push('');
    }
    return lines.join('\n');
}
/**
 * Check if enough time has passed since the last update check
 */
export function shouldCheckForUpdates(intervalHours = 24) {
    const installed = getInstalledVersion();
    if (!installed?.lastCheckAt) {
        return true;
    }
    const lastCheck = new Date(installed.lastCheckAt).getTime();
    const now = Date.now();
    const hoursSinceLastCheck = (now - lastCheck) / (1000 * 60 * 60);
    return hoursSinceLastCheck >= intervalHours;
}
/**
 * Perform a background update check (non-blocking)
 */
export function backgroundUpdateCheck(callback) {
    if (!shouldCheckForUpdates()) {
        return;
    }
    // Run the check asynchronously without blocking
    checkForUpdates()
        .then(result => {
        if (callback) {
            callback(result);
        }
        else if (result.updateAvailable) {
            // Default behavior: print notification to console
            console.log('\n' + formatUpdateNotification(result));
        }
    })
        .catch(error => {
        // Silently ignore errors in background checks
        if (process.env.OMC_DEBUG) {
            console.error('Background update check failed:', error);
        }
    });
}
/**
 * CLI helper: perform interactive update
 */
export async function interactiveUpdate() {
    console.log('Checking for updates...');
    try {
        const checkResult = await checkForUpdates();
        if (!checkResult.updateAvailable) {
            console.log(`✓ You are running the latest version (${checkResult.currentVersion})`);
            return;
        }
        console.log(formatUpdateNotification(checkResult));
        console.log('Starting update...\n');
        const result = await performUpdate({ verbose: true });
        if (result.success) {
            console.log(`\n✓ ${result.message}`);
            console.log('\nPlease restart your Claude Code session to use the new version.');
        }
        else {
            console.error(`\n✗ ${result.message}`);
            if (result.errors) {
                result.errors.forEach(err => console.error(`  - ${err}`));
            }
            process.exit(1);
        }
    }
    catch (error) {
        console.error('Update check failed:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
/** State file for tracking silent update status */
const SILENT_UPDATE_STATE_FILE = join(CLAUDE_CONFIG_DIR, '.omc-silent-update.json');
/**
 * Read silent update state
 */
function getSilentUpdateState() {
    if (!existsSync(SILENT_UPDATE_STATE_FILE)) {
        return { consecutiveFailures: 0, pendingRestart: false };
    }
    try {
        return JSON.parse(readFileSync(SILENT_UPDATE_STATE_FILE, 'utf-8'));
    }
    catch {
        return { consecutiveFailures: 0, pendingRestart: false };
    }
}
/**
 * Save silent update state
 */
function saveSilentUpdateState(state) {
    const dir = dirname(SILENT_UPDATE_STATE_FILE);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(SILENT_UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
}
/**
 * Log message to silent update log file (if configured)
 */
function silentLog(message, logFile) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    if (logFile) {
        try {
            const dir = dirname(logFile);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(logFile, logMessage, { flag: 'a' });
        }
        catch {
            // Silently ignore log errors
        }
    }
}
/**
 * Perform a completely silent update check and installation
 *
 * This function runs without any user interaction or console output.
 * It's designed to be called from hooks or startup scripts to keep
 * the system updated automatically without user awareness.
 *
 * Features:
 * - Rate-limited to prevent excessive checks
 * - Exponential backoff on failures
 * - Optional logging to file for debugging
 * - Tracks pending restart state
 *
 * @param config - Silent update configuration
 * @returns Promise resolving to update result or null if skipped
 */
export async function silentAutoUpdate(config = {}) {
    const { checkIntervalHours = 24, autoApply = true, logFile = join(CLAUDE_CONFIG_DIR, '.omc-update.log'), maxRetries = 3 } = config;
    // SECURITY: Check if silent auto-update is enabled in configuration
    // Default is disabled - users must explicitly opt-in during installation
    if (!isSilentAutoUpdateEnabled()) {
        silentLog('Silent auto-update is disabled (run installer to enable, or use /update)', logFile);
        return null;
    }
    const state = getSilentUpdateState();
    // Check rate limiting
    if (!shouldCheckForUpdates(checkIntervalHours)) {
        return null;
    }
    // Check for consecutive failures and apply exponential backoff
    if (state.consecutiveFailures >= maxRetries) {
        const backoffHours = Math.min(24 * state.consecutiveFailures, 168); // Max 1 week
        const lastAttempt = state.lastAttempt ? new Date(state.lastAttempt).getTime() : 0;
        const hoursSinceLastAttempt = (Date.now() - lastAttempt) / (1000 * 60 * 60);
        if (hoursSinceLastAttempt < backoffHours) {
            silentLog(`Skipping update check (in backoff period: ${backoffHours}h)`, logFile);
            return null;
        }
    }
    silentLog('Starting silent update check...', logFile);
    state.lastAttempt = new Date().toISOString();
    try {
        // Check for updates
        const checkResult = await checkForUpdates();
        if (!checkResult.updateAvailable) {
            silentLog(`No update available (current: ${checkResult.currentVersion})`, logFile);
            state.consecutiveFailures = 0;
            state.pendingRestart = false;
            saveSilentUpdateState(state);
            return null;
        }
        silentLog(`Update available: ${checkResult.currentVersion} -> ${checkResult.latestVersion}`, logFile);
        if (!autoApply) {
            silentLog('Auto-apply disabled, skipping installation', logFile);
            return null;
        }
        // Perform the update silently
        const result = await performUpdate({
            skipConfirmation: true,
            verbose: false
        });
        if (result.success) {
            silentLog(`Update successful: ${result.previousVersion} -> ${result.newVersion}`, logFile);
            state.consecutiveFailures = 0;
            state.pendingRestart = true;
            state.lastSuccess = new Date().toISOString();
            state.lastVersion = result.newVersion;
            saveSilentUpdateState(state);
            return result;
        }
        else {
            silentLog(`Update failed: ${result.message}`, logFile);
            state.consecutiveFailures++;
            saveSilentUpdateState(state);
            return result;
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        silentLog(`Update check error: ${errorMessage}`, logFile);
        state.consecutiveFailures++;
        saveSilentUpdateState(state);
        return {
            success: false,
            previousVersion: null,
            newVersion: 'unknown',
            message: `Silent update failed: ${errorMessage}`,
            errors: [errorMessage]
        };
    }
}
/**
 * Check if there's a pending restart after a silent update
 */
export function hasPendingUpdateRestart() {
    const state = getSilentUpdateState();
    return state.pendingRestart;
}
/**
 * Clear the pending restart flag (call after notifying user or restart)
 */
export function clearPendingUpdateRestart() {
    const state = getSilentUpdateState();
    state.pendingRestart = false;
    saveSilentUpdateState(state);
}
/**
 * Get the version that was silently updated to (if pending restart)
 */
export function getPendingUpdateVersion() {
    const state = getSilentUpdateState();
    return state.pendingRestart ? (state.lastVersion ?? null) : null;
}
/**
 * Initialize silent auto-update on startup
 *
 * This is the main entry point for the silent update system.
 * Call this function once when the application starts or from a hook.
 * It runs the update check completely in the background without blocking.
 *
 * @param config - Silent update configuration
 */
export function initSilentAutoUpdate(config = {}) {
    // Run update check in background without blocking
    silentAutoUpdate(config).catch(() => {
        // Silently ignore any errors - they're already logged
    });
}
//# sourceMappingURL=auto-update.js.map