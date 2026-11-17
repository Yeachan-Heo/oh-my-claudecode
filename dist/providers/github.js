import { execFileSync } from 'node:child_process';
export class GitHubProvider {
    name = 'github';
    displayName = 'GitHub';
    prTerminology = 'PR';
    prRefspec = 'pull/{number}/head:{branch}';
    detectFromRemote(url) {
        return url.includes('github.com');
    }
    viewPR(number, owner, repo) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        try {
            const args = ['pr', 'view', String(number)];
            if (owner && repo)
                args.push('--repo', `${owner}/${repo}`);
            args.push('--json', 'title,headRefName,baseRefName,body,url,author');
            const raw = execFileSync('gh', args, {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            return {
                title: data.title,
                headBranch: data.headRefName,
                baseBranch: data.baseRefName,
                body: data.body,
                url: data.url,
                author: data.author?.login,
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
            args.push('--json', 'title,body,labels,url');
            const raw = execFileSync('gh', args, {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            return {
                title: data.title,
                body: data.body,
                labels: data.labels?.map((l) => l.name),
                url: data.url,
            };
        }
        catch {
            return null;
        }
    }
    checkAuth() {
        try {
            execFileSync('gh', ['auth', 'status'], {
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
        return 'gh';
    }
}
//# sourceMappingURL=github.js.map