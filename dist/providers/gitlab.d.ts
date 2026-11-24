import type { GitProvider, PRInfo, IssueInfo } from './types.js';
export declare class GitLabProvider implements GitProvider {
    readonly name: "gitlab";
    readonly displayName = "GitLab";
    readonly prTerminology: "MR";
    readonly prRefspec = "merge-requests/{number}/head:{branch}";
    detectFromRemote(url: string): boolean;
    detectFromApi(baseUrl: string): Promise<boolean>;
    viewPR(number: number, owner?: string, repo?: string): PRInfo | null;
    viewIssue(number: number, owner?: string, repo?: string): IssueInfo | null;
    checkAuth(): boolean;
    getRequiredCLI(): string | null;
}
//# sourceMappingURL=gitlab.d.ts.map