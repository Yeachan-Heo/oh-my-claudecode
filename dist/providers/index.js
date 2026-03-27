/**
 * Git Provider Detection and Registry
 *
 * Auto-detects git hosting provider from remote URLs and provides
 * access to provider-specific adapters.
 */
import { execSync } from 'node:child_process';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { BitbucketProvider } from './bitbucket.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import { GiteaProvider } from './gitea.js';
// Singleton provider registry
let providerRegistry = null;
// TTL cache for git remote URL lookups keyed on resolved cwd
const REMOTE_URL_CACHE_TTL_MS = 60_000;
const remoteUrlCache = new Map();
/**
 * Reset the remote URL cache. Intended for use in tests.
 */
export function resetProviderCache() {
    remoteUrlCache.clear();
}
function getCachedRemoteUrl(cwd) {
    const entry = remoteUrlCache.get(cwd);
    if (!entry)
        return undefined; // cache miss
    if (Date.now() > entry.expiresAt) {
        remoteUrlCache.delete(cwd);
        return undefined; // expired
    }
    return entry.url; // may be null (cached "not a git repo")
}
function setCachedRemoteUrl(cwd, url) {
    remoteUrlCache.set(cwd, { url, expiresAt: Date.now() + REMOTE_URL_CACHE_TTL_MS });
}
function getRemoteUrl(cwd) {
    const resolvedCwd = cwd ?? process.cwd();
    const cached = getCachedRemoteUrl(resolvedCwd);
    if (cached !== undefined)
        return cached;
    try {
        const url = execSync('git remote get-url origin', {
            cwd: resolvedCwd,
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const result = url || null;
        setCachedRemoteUrl(resolvedCwd, result);
        return result;
    }
    catch {
        setCachedRemoteUrl(resolvedCwd, null);
        return null;
    }
}
/**
 * Detect provider from a git remote URL by matching known hostnames.
 */
export function detectProvider(remoteUrl) {
    const url = remoteUrl.toLowerCase();
    // Extract host portion for accurate matching (strip port if present)
    const hostMatch = url.match(/^(?:https?:\/\/|ssh:\/\/[^@]*@|[^@]+@)([^/:]+)/);
    const rawHost = hostMatch ? hostMatch[1].toLowerCase() : '';
    const host = rawHost.replace(/:\d+$/, ''); // strip port for matching
    // Azure DevOps (check before generic patterns)
    if (host.includes('dev.azure.com') || host.includes('ssh.dev.azure.com') || host.endsWith('.visualstudio.com')) {
        return 'azure-devops';
    }
    // GitHub
    if (host === 'github.com') {
        return 'github';
    }
    // GitLab (SaaS)
    if (host === 'gitlab.com') {
        return 'gitlab';
    }
    // Bitbucket
    if (host === 'bitbucket.org') {
        return 'bitbucket';
    }
    // Self-hosted heuristics — match hostname labels only
    if (/(^|[.-])gitlab([.-]|$)/.test(host)) {
        return 'gitlab';
    }
    if (/(^|[.-])gitea([.-]|$)/.test(host)) {
        return 'gitea';
    }
    if (/(^|[.-])forgejo([.-]|$)/.test(host)) {
        return 'forgejo';
    }
    return 'unknown';
}
/**
 * Parse a git remote URL into structured components.
 * Supports HTTPS, SSH (SCP-style), and provider-specific formats.
 */
export function parseRemoteUrl(url) {
    const trimmed = url.trim();
    // Azure DevOps HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}
    const azureHttpsMatch = trimmed.match(/https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s]+?)(?:\.git)?$/);
    if (azureHttpsMatch) {
        return {
            provider: 'azure-devops',
            host: 'dev.azure.com',
            owner: `${azureHttpsMatch[1]}/${azureHttpsMatch[2]}`,
            repo: azureHttpsMatch[3],
        };
    }
    // Azure DevOps SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    const azureSshMatch = trimmed.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
    if (azureSshMatch) {
        return {
            provider: 'azure-devops',
            host: 'dev.azure.com',
            owner: `${azureSshMatch[1]}/${azureSshMatch[2]}`,
            repo: azureSshMatch[3],
        };
    }
    // Azure DevOps legacy HTTPS: https://{org}.visualstudio.com/{project}/_git/{repo}
    const azureLegacyMatch = trimmed.match(/https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/\s]+?)(?:\.git)?$/);
    if (azureLegacyMatch) {
        return {
            provider: 'azure-devops',
            host: `${azureLegacyMatch[1]}.visualstudio.com`,
            owner: `${azureLegacyMatch[1]}/${azureLegacyMatch[2]}`,
            repo: azureLegacyMatch[3],
        };
    }
    // Standard HTTPS: https://host/owner/repo.git (supports nested groups like group/subgroup/repo)
    const httpsMatch = trimmed.match(/https?:\/\/([^/]+)\/(.+?)\/([^/\s]+?)(?:\.git)?$/);
    if (httpsMatch) {
        const host = httpsMatch[1];
        return {
            provider: detectProvider(trimmed),
            host,
            owner: httpsMatch[2],
            repo: httpsMatch[3],
        };
    }
    // SSH URL-style: ssh://git@host[:port]/owner/repo.git (must check before SCP-style)
    const sshUrlMatch = trimmed.match(/ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)\/([^/\s]+?)(?:\.git)?$/);
    if (sshUrlMatch) {
        const host = sshUrlMatch[1];
        return {
            provider: detectProvider(trimmed),
            host,
            owner: sshUrlMatch[2],
            repo: sshUrlMatch[3],
        };
    }
    // SSH SCP-style: git@host:owner/repo.git (supports nested groups like group/subgroup/repo)
    const sshMatch = trimmed.match(/git@([^:]+):(.+?)\/([^/\s]+?)(?:\.git)?$/);
    if (sshMatch) {
        const host = sshMatch[1];
        return {
            provider: detectProvider(trimmed),
            host,
            owner: sshMatch[2],
            repo: sshMatch[3],
        };
    }
    return null;
}
/**
 * Detect the git provider for the current working directory
 * by reading the origin remote URL.
 */
export function detectProviderFromCwd(cwd) {
    const url = getRemoteUrl(cwd);
    if (!url)
        return 'unknown';
    return detectProvider(url);
}
/**
 * Parse the remote URL for the current working directory.
 */
export function parseRemoteFromCwd(cwd) {
    const url = getRemoteUrl(cwd);
    if (!url)
        return null;
    return parseRemoteUrl(url);
}
/**
 * Initialize the provider registry with all available providers.
 */
function initRegistry() {
    if (providerRegistry)
        return providerRegistry;
    providerRegistry = new Map([
        ['github', new GitHubProvider()],
        ['gitlab', new GitLabProvider()],
        ['bitbucket', new BitbucketProvider()],
        ['azure-devops', new AzureDevOpsProvider()],
        ['gitea', new GiteaProvider()],
        ['forgejo', new GiteaProvider({ name: 'forgejo', displayName: 'Forgejo' })],
    ]);
    return providerRegistry;
}
/**
 * Get a provider instance by name.
 * Returns null if the provider is not registered.
 */
export function getProvider(name) {
    const registry = initRegistry();
    return registry.get(name) ?? null;
}
/**
 * Get a provider for the current working directory.
 * Detects the provider from the git remote URL and returns its adapter.
 */
export function getProviderFromCwd(cwd) {
    const name = detectProviderFromCwd(cwd);
    if (name === 'unknown')
        return null;
    return getProvider(name);
}
//# sourceMappingURL=index.js.map