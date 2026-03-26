/**
 * Git Provider Abstraction Types
 *
 * Shared interfaces for multi-provider git hosting support.
 * Providers: GitHub, GitLab, Bitbucket, Azure DevOps, Gitea/Forgejo.
 */

/** Supported git hosting provider identifiers */
export type ProviderName =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea'
  | 'forgejo'
  | 'unknown';

/** Parsed remote URL information */
export interface RemoteUrlInfo {
  provider: ProviderName;
  host: string;
  owner: string;
  repo: string;
}

/** Pull request / merge request information */
export interface PRInfo {
  title: string;
  headBranch?: string;
  baseBranch?: string;
  url?: string;
  body?: string;
  author?: string;
}

/** Issue / work item information */
export interface IssueInfo {
  title: string;
  body?: string;
  labels?: string[];
  url?: string;
}

/**
 * Git hosting provider interface.
 *
 * Each provider implements this to support PR/issue operations
 * via its CLI tool or REST API.
 */
export interface GitProvider {
  /** Provider identifier */
  readonly name: ProviderName;

  /** Human-readable name (e.g., "GitHub", "GitLab") */
  readonly displayName: string;

  /** What this provider calls PRs: 'PR' or 'MR' */
  readonly prTerminology: 'PR' | 'MR';

  /**
   * Git refspec pattern for fetching PR/MR branches.
   * Use {number} as placeholder for the PR/MR number
   * and {branch} for the local branch name.
   * Example: "pull/{number}/head:{branch}" for GitHub.
   * Null if provider doesn't support refspec-based fetching.
   */
  readonly prRefspec: string | null;

  /** Check if a remote URL belongs to this provider */
  detectFromRemote(url: string): boolean;

  /** Probe an API endpoint to detect this provider (for self-hosted) */
  detectFromApi?(baseUrl: string): Promise<boolean>;

  /** Fetch PR/MR information */
  viewPR(number: number, owner?: string, repo?: string): PRInfo | null | Promise<PRInfo | null>;

  /** Fetch issue/work-item information */
  viewIssue(number: number, owner?: string, repo?: string): IssueInfo | null | Promise<IssueInfo | null>;

  /** Check if the provider's CLI is authenticated */
  checkAuth(): boolean;

  /** Return the required CLI tool name, or null if API-only */
  getRequiredCLI(): string | null;
}
