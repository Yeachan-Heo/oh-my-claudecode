import type { GitProvider, PRInfo, IssueInfo } from './types.js';

const API_BASE = 'https://api.bitbucket.org/2.0/repositories';

function getAuthHeader(): string | null {
  const token = process.env.BITBUCKET_TOKEN;
  if (token) {
    return `Bearer ${token}`;
  }
  const username = process.env.BITBUCKET_USERNAME;
  const appPassword = process.env.BITBUCKET_APP_PASSWORD;
  if (username && appPassword) {
    return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
  }
  return null;
}

async function fetchApi(url: string): Promise<Record<string, unknown> | null> {
  const auth = getAuthHeader();
  if (!auth) return null;
  try {
    const response = await fetch(url, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class BitbucketProvider implements GitProvider {
  readonly name = 'bitbucket' as const;
  readonly displayName = 'Bitbucket';
  readonly prTerminology = 'PR' as const;
  readonly prRefspec = null;

  detectFromRemote(url: string): boolean {
    return url.includes('bitbucket.org');
  }

  async viewPR(number: number, owner?: string, repo?: string): Promise<PRInfo | null> {
    if (!Number.isInteger(number) || number < 1) return null;
    if (!owner || !repo) return null;
    const data = await fetchApi(`${API_BASE}/${owner}/${repo}/pullrequests/${number}`);
    if (!data) return null;
    const source = data.source as Record<string, unknown> | undefined;
    const dest = data.destination as Record<string, unknown> | undefined;
    const sourceBranch = source?.branch as Record<string, unknown> | undefined;
    const destBranch = dest?.branch as Record<string, unknown> | undefined;
    const links = data.links as Record<string, unknown> | undefined;
    const htmlLink = links?.html as Record<string, unknown> | undefined;
    const author = data.author as Record<string, unknown> | undefined;
    return {
      title: data.title as string,
      headBranch: sourceBranch?.name as string | undefined,
      baseBranch: destBranch?.name as string | undefined,
      url: htmlLink?.href as string | undefined,
      body: data.description as string | undefined,
      author: author?.display_name as string | undefined,
    };
  }

  async viewIssue(number: number, owner?: string, repo?: string): Promise<IssueInfo | null> {
    if (!Number.isInteger(number) || number < 1) return null;
    if (!owner || !repo) return null;
    const data = await fetchApi(`${API_BASE}/${owner}/${repo}/issues/${number}`);
    if (!data) return null;
    const content = data.content as Record<string, unknown> | undefined;
    const links = data.links as Record<string, unknown> | undefined;
    const htmlLink = links?.html as Record<string, unknown> | undefined;
    return {
      title: data.title as string,
      body: content?.raw as string | undefined,
      url: htmlLink?.href as string | undefined,
    };
  }

  checkAuth(): boolean {
    return getAuthHeader() !== null;
  }

  getRequiredCLI(): string | null {
    return null;
  }
}
