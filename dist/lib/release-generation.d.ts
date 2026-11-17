export interface ReleasePullRequest {
    number: string;
    title: string;
    author: string | null;
    headRefName: string | null;
}
export interface ReleaseNoteEntry {
    type: string;
    scope: string;
    description: string;
    prNumber: string | null;
}
export declare function getLatestTag(options?: {
    cwd?: string;
    excludeTag?: string;
    ref?: string;
}): string;
export declare function extractPullRequestNumbers(subjects: string[]): string[];
export declare function isReleasePullRequest(pr: Pick<ReleasePullRequest, 'title' | 'headRefName'>): boolean;
export declare function deriveContributorLogins(pullRequests: Array<Pick<ReleasePullRequest, 'author'>>, compareCommitAuthors: Array<string | null | undefined>): string[];
export declare function buildReleaseNoteEntriesFromPullRequests(pullRequests: ReleasePullRequest[]): ReleaseNoteEntry[];
export declare function categorizeReleaseNoteEntries(entries: ReleaseNoteEntry[]): Map<string, ReleaseNoteEntry[]>;
export declare function generateChangelog(version: string, categories: Map<string, ReleaseNoteEntry[]>, prCount: number): string;
export declare function generateReleaseBody(version: string, changelog: string, contributors: string[], prevTag: string, repoUrl?: string): string;
//# sourceMappingURL=release-generation.d.ts.map