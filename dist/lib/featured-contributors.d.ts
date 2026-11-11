export declare const FEATURED_CONTRIBUTORS_START_MARKER = "<!-- OMC:FEATURED-CONTRIBUTORS:START -->";
export declare const FEATURED_CONTRIBUTORS_END_MARKER = "<!-- OMC:FEATURED-CONTRIBUTORS:END -->";
export declare const FEATURED_CONTRIBUTORS_TITLE = "## Featured by OmC Contributors";
export declare const FEATURED_CONTRIBUTORS_MIN_STARS = 100;
export interface GitHubContributor {
    login: string;
    html_url: string;
    type: string;
    contributions: number;
}
export interface GitHubRepo {
    name: string;
    full_name: string;
    html_url: string;
    stargazers_count: number;
    fork: boolean;
    archived?: boolean;
    owner: {
        login: string;
        type: string;
    };
}
export interface FeaturedContributor {
    login: string;
    profileUrl: string;
    repoName: string;
    repoFullName: string;
    repoUrl: string;
    stars: number;
}
export interface SyncFeaturedContributorsOptions {
    dryRun?: boolean;
    minStars?: number;
    projectRoot?: string;
    readmePath?: string;
    repoSlug?: string;
}
export interface SyncFeaturedContributorsResult {
    changed: boolean;
    changes: string[];
    entries: FeaturedContributor[];
    readmePath: string;
}
export interface CliOptions {
    dryRun: boolean;
    help: boolean;
    minStars?: number;
    repoSlug?: string;
    verify: boolean;
}
export declare function extractRepoSlug(repositoryUrl: string): string;
export declare function loadRepoSlugFromPackageJson(projectRoot: string): string;
export declare function formatStarCount(stars: number): string;
export declare function sortFeaturedContributors(entries: FeaturedContributor[]): FeaturedContributor[];
export declare function pickTopPersonalRepo(login: string, repos: GitHubRepo[]): GitHubRepo | null;
export declare function collectFeaturedContributors(repoSlug: string, minStars?: number): Promise<FeaturedContributor[]>;
export declare function renderFeaturedContributorsSection(entries: FeaturedContributor[], minStars?: number): string;
export declare function upsertFeaturedContributorsSection(readmeContent: string, featuredSection: string, anchor?: string): string;
export declare function syncFeaturedContributorsReadme(options?: SyncFeaturedContributorsOptions): Promise<SyncFeaturedContributorsResult>;
export declare function parseCliOptions(args: string[]): CliOptions;
export declare function runFeaturedContributorsCli(args?: string[]): Promise<void>;
//# sourceMappingURL=featured-contributors.d.ts.map