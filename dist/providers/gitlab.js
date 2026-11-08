import { execFileSync } from 'node:child_process';
export class GitLabProvider {
    name = 'gitlab';
    displayName = 'GitLab';
    prTerminology = 'MR';
    prRefspec = 'merge-requests/{number}/head:{branch}';
    detectFromRemote(url) {
        const lower = url.toLowerCase();
        if (lower.includes('gitlab.com'))
            return true;
        // Self-hosted: match hostname label containing 'gitlab', not path/query
        const hostMatch = lower.match(/^(?:https?:\/\/|ssh:\/\/[^@]*@|[^@]+@)([^/:]+)/);
        const host = hostMatch ? hostMatch[1] : '';
        return /(^|[.-])gitlab([.-]|$)/.test(host);
    }
    async detectFromApi(baseUrl) {
        try {
            const response = await fetch(`${baseUrl}/api/v4/version`);
            return response.ok;
        }
        catch {
            return false;
        }
    }
    viewPR(number, owner, repo) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        try {
            const args = ['mr', 'view', String(number)];
            if (owner && repo)
                args.push('--repo', `${owner}/${repo}`);
            args.push('--output', 'json');
            const raw = execFileSync('glab', args, {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            return {
                title: data.title,
                headBranch: data.source_branch,
                baseBranch: data.target_branch,
                url: data.web_url,
                body: data.description,
                author: data.author?.username,
            };
        }
        catch {
            return null;
        }
    }
    viewIssue(number, owner, repo) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        try {
            const args = ['issue', 'view', String(number)];
            if (owner && repo)
                args.push('--repo', `${owner}/${repo}`);
            args.push('--output', 'json');
            const raw = execFileSync('glab', args, {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            return {
                title: data.title,
                body: data.description,
                url: data.web_url,
                labels: data.labels,
            };
        }
        catch {
            return null;
        }
    }
    checkAuth() {
        try {
            execFileSync('glab', ['auth', 'status'], {
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
        return 'glab';
    }
}
//# sourceMappingURL=gitlab.js.map