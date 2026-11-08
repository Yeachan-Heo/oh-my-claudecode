/**
 * Git Provider Detection and Registry
 *
 * Auto-detects git hosting provider from remote URLs and provides
 * access to provider-specific adapters.
 */
import type { ProviderName, RemoteUrlInfo, GitProvider } from './types.js';
/**
 * Reset the remote URL cache. Intended for use in tests.
 */
export declare function resetProviderCache(): void;
/**
 * Detect provider from a git remote URL by matching known hostnames.
 */
export declare function detectProvider(remoteUrl: string): ProviderName;
/**
 * Parse a git remote URL into structured components.
 * Supports HTTPS, SSH (SCP-style), and provider-specific formats.
 */
export declare function parseRemoteUrl(url: string): RemoteUrlInfo | null;
/**
 * Detect the git provider for the current working directory
 * by reading the origin remote URL.
 */
export declare function detectProviderFromCwd(cwd?: string): ProviderName;
/**
 * Parse the remote URL for the current working directory.
 */
export declare function parseRemoteFromCwd(cwd?: string): RemoteUrlInfo | null;
/**
 * Get a provider instance by name.
 * Returns null if the provider is not registered.
 */
export declare function getProvider(name: ProviderName): GitProvider | null;
/**
 * Get a provider for the current working directory.
 * Detects the provider from the git remote URL and returns its adapter.
 */
export declare function getProviderFromCwd(cwd?: string): GitProvider | null;
export type { ProviderName, RemoteUrlInfo, GitProvider, PRInfo, IssueInfo } from './types.js';
//# sourceMappingURL=index.d.ts.map