import { execFileSync } from 'node:child_process';
import type { GitProvider, PRInfo, IssueInfo } from './types.js';

function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

export function isAzureDevOpsHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'dev.azure.com' || normalized === 'ssh.dev.azure.com' || normalized.endsWith('.visualstudio.com');
}

export class AzureDevOpsProvider implements GitProvider {
  readonly name = 'azure-devops' as const;
  readonly displayName = 'Azure DevOps';
  readonly prTerminology = 'PR' as const;
  readonly prRefspec = null;

  detectFromRemote(url: string): boolean {
    const host = url.match(/^(?:https?:\/\/|ssh:\/\/[^@]*@|[^@]+@)([^/:]+)/i)?.[1];
    return !!host && isAzureDevOpsHost(host);
  }

  viewPR(number: number): PRInfo | null {
    if (!Number.isInteger(number) || number < 1) return null;
    try {
      const raw = execFileSync('az', ['repos', 'pr', 'show', '--id', String(number), '--output', 'json'], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      const createdBy = data.createdBy as Record<string, unknown> | undefined;
      return {
        title: data.title as string,
        headBranch: data.sourceRefName ? stripRefPrefix(data.sourceRefName as string) : undefined,
        baseBranch: data.targetRefName ? stripRefPrefix(data.targetRefName as string) : undefined,
        url: data.url as string | undefined,
        body: data.description as string | undefined,
        author: createdBy?.displayName as string | undefined,
      };
    } catch {
      return null;
    }
  }

  viewIssue(number: number): IssueInfo | null {
    if (!Number.isInteger(number) || number < 1) return null;
    try {
      const raw = execFileSync('az', ['boards', 'work-item', 'show', '--id', String(number), '--output', 'json'], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      const fields = data.fields as Record<string, unknown> | undefined;
      return {
        title: (fields?.['System.Title'] as string) ?? '',
        body: fields?.['System.Description'] as string | undefined,
        url: data.url as string | undefined,
      };
    } catch {
      return null;
    }
  }

  checkAuth(): boolean {
    try {
      execFileSync('az', ['account', 'show'], {
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
    return 'az';
  }
}
