import type { GitProvider, PRInfo, IssueInfo } from './types.js';
export declare class GitHubProvider implements GitProvider {
    readonly name: "github";
    readonly displayName = "GitHub";
    readonly prTerminology: "PR";
    readonly prRefspec = "pull/{number}/head:{branch}";
    detectFromRemote(url: string): boolean;
    viewPR(number: number, owner?: string, repo?: string): PRInfo | null;
    viewIssue(number: number, owner?: string, repo?: string): IssueInfo | null;
    checkAuth(): boolean;
    getRequiredCLI(): string | null;
}
//# sourceMappingURL=github.d.ts.map