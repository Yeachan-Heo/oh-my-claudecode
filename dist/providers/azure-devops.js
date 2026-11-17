import { execFileSync } from 'node:child_process';
function stripRefPrefix(ref) {
    return ref.replace(/^refs\/heads\//, '');
}
export function isAzureDevOpsHost(host) {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    return normalized === 'dev.azure.com' || normalized === 'ssh.dev.azure.com' || normalized.endsWith('.visualstudio.com');
}
export class AzureDevOpsProvider {
    name = 'azure-devops';
    displayName = 'Azure DevOps';
    prTerminology = 'PR';
    prRefspec = null;
    detectFromRemote(url) {
        const host = url.match(/^(?:https?:\/\/(?:[^@/?#]+@)?|ssh:\/\/[^@/?#]*@|[^@/:?#]+@)([^/:?#]+)/i)?.[1];
        return !!host && isAzureDevOpsHost(host);
    }
    viewPR(number) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        try {
            const raw = execFileSync('az', ['repos', 'pr', 'show', '--id', String(number), '--output', 'json'], {
                encoding: 'utf-8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            const createdBy = data.createdBy;
            return {
                title: data.title,
                headBranch: data.sourceRefName ? stripRefPrefix(data.sourceRefName) : undefined,
                baseBranch: data.targetRefName ? stripRefPrefix(data.targetRefName) : undefined,
                url: data.url,
                body: data.description,
                author: createdBy?.displayName,
            };
        }
        catch {
            return null;
        }
    }
    viewIssue(number) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        try {
            const raw = execFileSync('az', ['boards', 'work-item', 'show', '--id', String(number), '--output', 'json'], {
                encoding: 'utf-8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            const fields = data.fields;
            return {
                title: fields?.['System.Title'] ?? '',
                body: fields?.['System.Description'],
                url: data.url,
            };
        }
        catch {
            return null;
        }
    }
    checkAuth() {
        try {
            execFileSync('az', ['account', 'show'], {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return true;
        }
        catch {
            return false;
        }
    }
    getRequiredCLI() {
        return 'az';
    }
}
//# sourceMappingURL=azure-devops.js.map