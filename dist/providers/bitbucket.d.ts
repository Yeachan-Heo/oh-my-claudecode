import type { GitProvider, PRInfo, IssueInfo } from './types.js';
export declare class BitbucketProvider implements GitProvider {
    readonly name: "bitbucket";
    readonly displayName = "Bitbucket";
    readonly prTerminology: "PR";
    readonly prRefspec: null;
    detectFromRemote(url: string): boolean;
    viewPR(number: number, owner?: string, repo?: string): Promise<PRInfo | null>;
    viewIssue(number: number, owner?: string, repo?: string): Promise<IssueInfo | null>;
    checkAuth(): boolean;
    getRequiredCLI(): string | null;
}
//# sourceMappingURL=bitbucket.d.ts.map