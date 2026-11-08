import { execFileSync } from 'node:child_process';
import type { GitProvider, PRInfo, IssueInfo } from './types.js';

export class GitHubProvider implements GitProvider {
  readonly name = 'github' as const;
  readonly displayName = 'GitHub';
  readonly prTerminology = 'PR' as const;
  readonly prRefspec = 'pull/{number}/head:{branch}';

  detectFromRemote(url: string): boolean {
    return url.includes('github.com');
  }

  viewPR(number: number, owner?: string, repo?: string): PRInfo | null {
    if (!Number.isInteger(number) || number < 1) return null;
    try {
      const args = ['pr', 'view', String(number)];
      if (owner && repo) args.push('--repo', `${owner}/${repo}`);
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
    } catch {
      return null;
    }
  }

  viewIssue(number: number, owner?: string, repo?: string): IssueInfo | null {
    if (!Number.isInteger(number) || number < 1) return null;
    try {
      const args = ['issue', 'view', String(number)];
      if (owner && repo) args.push('--repo', `${owner}/${repo}`);
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
        labels: data.labels?.map((l: { name: string }) => l.name),
        url: data.url,
      };
    } catch {
      return null;
    }
  }

  checkAuth(): boolean {
    try {
      execFileSync('gh', ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  getRequiredCLI(): string | null {
    return 'gh';
  }
}
