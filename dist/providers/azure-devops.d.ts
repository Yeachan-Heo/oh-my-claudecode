import type { GitProvider, PRInfo, IssueInfo } from './types.js';
export declare function isAzureDevOpsHost(host: string): boolean;
export declare class AzureDevOpsProvider implements GitProvider {
    readonly name: "azure-devops";
    readonly displayName = "Azure DevOps";
    readonly prTerminology: "PR";
    readonly prRefspec: null;
    detectFromRemote(url: string): boolean;
    viewPR(number: number): PRInfo | null;
    viewIssue(number: number): IssueInfo | null;
    checkAuth(): boolean;
    getRequiredCLI(): string | null;
}
//# sourceMappingURL=azure-devops.d.ts.map