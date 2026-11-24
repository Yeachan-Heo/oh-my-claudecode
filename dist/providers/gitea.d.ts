import type { GitProvider, PRInfo, IssueInfo, ProviderName } from './types.js';
export declare class GiteaProvider implements GitProvider {
    readonly name: ProviderName;
    readonly displayName: string;
    readonly prTerminology: "PR";
    readonly prRefspec: null;
    constructor(options?: {
        name?: 'gitea' | 'forgejo';
        displayName?: string;
    });
    detectFromRemote(_url: string): boolean;
    detectFromApi(baseUrl: string): Promise<boolean>;
    viewPR(number: number, owner?: string, repo?: string): PRInfo | null;
    private viewPRviaRest;
    viewIssue(number: number, owner?: string, repo?: string): IssueInfo | null;
    private viewIssueviaRest;
    checkAuth(): boolean;
    getRequiredCLI(): string | null;
}
//# sourceMappingURL=gitea.d.ts.map