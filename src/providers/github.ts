import { execFileSync } from 'node:child_process';
import type { GitProvider, PRInfo, IssueInfo } from './types.js';

interface ExecError extends Error {
  status?: number;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
}

function ghStderr(err: unknown): string {
  const e = err as ExecError;
  if (!e) return '';
  const s = e.stderr;
  if (s == null) return '';
  return Buffer.isBuffer(s) ? s.toString('utf-8') : String(s);
}

function isAlreadyExistsError(err: unknown): boolean {
  const text = `${ghStderr(err)} ${(err as Error)?.message ?? ''}`;
  return /already_exists|already exists|HTTP 422/i.test(text);
}

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
      args.push('--json', 'title,body,labels,url,author');
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
        author: data.author?.login,
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

  /**
   * Verify the authenticated user has push (write) scope on the target repo.
   * Two-step probe: `gh auth status` covers OAuth tokens; `gh api repos/{repo} -q
   * .permissions.push` covers fine-grained PATs whose scopes are not visible to
   * `auth status`. Returns true only when both checks pass.
   */
  checkWriteScope(repo?: string): boolean {
    if (!this.checkAuth()) return false;
    try {
      const args = ['api'];
      if (repo) args.push(`repos/${repo}`);
      else args.push('repos/{owner}/{repo}');
      args.push('-q', '.permissions.push');
      const raw = execFileSync('gh', args, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return raw.trim() === 'true';
    } catch {
      return false;
    }
  }

  getRequiredCLI(): string | null {
    return 'gh';
  }

  /**
   * Create a new issue. Returns { number, url } on success, null on failure.
   * NOT idempotent — caller must search content hash before invoking.
   */
  createIssue(args: {
    title: string;
    body: string;
    labels?: string[];
    milestone?: string;
    repo?: string;
  }): { number: number; url: string } | null {
    if (!args.title) return null;
    try {
      const cli = ['issue', 'create', '--title', args.title, '--body', args.body];
      if (args.repo) cli.push('--repo', args.repo);
      if (args.labels && args.labels.length > 0) cli.push('--label', args.labels.join(','));
      if (args.milestone) cli.push('--milestone', args.milestone);
      const url = execFileSync('gh', cli, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const match = url.match(/\/issues\/(\d+)\b/);
      if (!match) return null;
      return { number: parseInt(match[1], 10), url };
    } catch {
      return null;
    }
  }

  /**
   * List issues with optional filters. Returns [] on failure.
   */
  listIssues(args: {
    repo?: string;
    state?: 'open' | 'closed' | 'all';
    labels?: string[];
    search?: string;
    limit?: number;
  }): Array<{ number: number; title: string; body: string; labels: string[]; url: string }> {
    try {
      const cli = ['issue', 'list', '--json', 'number,title,body,labels,url'];
      if (args.repo) cli.push('--repo', args.repo);
      cli.push('--state', args.state ?? 'open');
      if (args.labels && args.labels.length > 0) cli.push('--label', args.labels.join(','));
      if (args.search) cli.push('--search', args.search);
      cli.push('--limit', String(args.limit ?? 100));
      const raw = execFileSync('gh', cli, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.map((it: { number: number; title: string; body?: string; labels?: { name: string }[]; url: string }) => ({
        number: it.number,
        title: it.title,
        body: it.body ?? '',
        labels: (it.labels ?? []).map((l) => l.name),
        url: it.url,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Search issues by raw query string. Read-only. Returns [] on failure.
   * Callers post-filter the body for full sentinel matches.
   */
  searchIssues(
    query: string,
    args: { repo?: string; state?: 'open' | 'closed' | 'all' },
  ): Array<{ number: number; body: string; url: string }> {
    if (!query) return [];
    try {
      const cli = ['issue', 'list', '--search', query, '--json', 'number,body,url'];
      if (args.repo) cli.push('--repo', args.repo);
      cli.push('--state', args.state ?? 'all');
      cli.push('--limit', '100');
      const raw = execFileSync('gh', cli, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.map((it: { number: number; body?: string; url: string }) => ({
        number: it.number,
        body: it.body ?? '',
        url: it.url,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Ensure a label exists on the repo. Idempotent — HTTP 422 (already exists)
   * is treated as success.
   */
  ensureLabel(
    name: string,
    args?: { repo?: string; color?: string; description?: string },
  ): boolean {
    if (!name) return false;
    try {
      const cli = ['label', 'create', name];
      if (args?.repo) cli.push('--repo', args.repo);
      if (args?.color) cli.push('--color', args.color);
      if (args?.description) cli.push('--description', args.description);
      execFileSync('gh', cli, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (err) {
      return isAlreadyExistsError(err);
    }
  }

  /**
   * Ensure a milestone exists on the repo. Idempotent — HTTP 422 (already
   * exists) is treated as success and the existing milestone is looked up.
   * Returns the milestone number on success, null on real error.
   */
  ensureMilestone(
    name: string,
    args?: { repo?: string; description?: string; state?: 'open' | 'closed' },
  ): number | null {
    if (!name) return null;
    const repoArg = args?.repo ? `repos/${args.repo}/milestones` : 'repos/{owner}/{repo}/milestones';
    const createArgs = ['api', '--method', 'POST', repoArg, '-f', `title=${name}`];
    if (args?.description) createArgs.push('-f', `description=${args.description}`);
    if (args?.state) createArgs.push('-f', `state=${args.state}`);
    try {
      const raw = execFileSync('gh', createArgs, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      return typeof data?.number === 'number' ? data.number : null;
    } catch (err) {
      if (!isAlreadyExistsError(err)) return null;
      try {
        const lookup = ['api', repoArg, '--jq', `.[] | select(.title == "${name}") | .number`];
        const raw = execFileSync('gh', lookup, {
          encoding: 'utf-8',
          timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (!raw) return null;
        const num = parseInt(raw.split(/\s+/)[0], 10);
        return Number.isFinite(num) ? num : null;
      } catch {
        return null;
      }
    }
  }

  /**
   * Add a comment to an existing issue. NOT idempotent — caller must check
   * listIssueComments() for a session-marker pattern first.
   */
  addIssueComment(number: number, body: string, args?: { repo?: string }): boolean {
    if (!Number.isInteger(number) || number < 1) return false;
    if (!body) return false;
    try {
      const cli = ['issue', 'comment', String(number), '--body', body];
      if (args?.repo) cli.push('--repo', args.repo);
      execFileSync('gh', cli, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List existing comments on an issue. Read-only. Returns [] on failure.
   */
  listIssueComments(number: number, args?: { repo?: string }): string[] {
    if (!Number.isInteger(number) || number < 1) return [];
    try {
      const cli = ['issue', 'view', String(number), '--json', 'comments'];
      if (args?.repo) cli.push('--repo', args.repo);
      const raw = execFileSync('gh', cli, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      const comments = data?.comments;
      if (!Array.isArray(comments)) return [];
      return comments
        .map((c: { body?: string }) => c?.body ?? '')
        .filter((b: string) => typeof b === 'string');
    } catch {
      return [];
    }
  }
}
