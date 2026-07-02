import { execFileSync } from 'node:child_process';
import { parseRemoteUrl } from '../../providers/index.js';

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_LIST_RESULTS = 100;
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

interface GitHubListEntry {
  number?: number;
}

interface GitHubRunEntry {
  databaseId?: number;
  conclusion?: string | null;
}

export interface IdleNotificationRepoState {
  signature: string;
  backlogZero: boolean;
}

function runCommand(command: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(command, args, {
      windowsHide: true,
      cwd,
      encoding: 'utf-8',
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function runJsonCommand<T>(command: string, args: string[], cwd: string): T | null {
  const raw = runCommand(command, args, cwd);
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toSortedNumbers(values: Array<number | undefined>): number[] {
  return values
    .filter((value): value is number => Number.isInteger(value))
    .sort((left, right) => left - right);
}

export function getIdleNotificationRepoState(directory: string): IdleNotificationRepoState | null {
  const remoteUrl = runCommand('git', ['remote', 'get-url', 'origin'], directory);
  if (!remoteUrl) return null;

  const remote = parseRemoteUrl(remoteUrl);
  if (!remote || remote.provider !== 'github') return null;

  const repo = `${remote.owner}/${remote.repo}`;
  const headSha = runCommand('git', ['rev-parse', 'HEAD'], directory);
  const porcelainStatus = runCommand('git', ['status', '--porcelain'], directory);
  if (!headSha || porcelainStatus === null) return null;

  const openPrs = runJsonCommand<GitHubListEntry[]>(
    'gh',
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(MAX_LIST_RESULTS), '--json', 'number'],
    directory,
  );
  if (!openPrs) return null;

  const openIssues = runJsonCommand<GitHubListEntry[]>(
    'gh',
    ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(MAX_LIST_RESULTS), '--json', 'number'],
    directory,
  );
  if (!openIssues) return null;

  const runs = runJsonCommand<GitHubRunEntry[]>(
    'gh',
    ['run', 'list', '--repo', repo, '--limit', String(MAX_LIST_RESULTS), '--json', 'databaseId,conclusion'],
    directory,
  );
  if (!runs) return null;

  const failingRunIds = toSortedNumbers(
    runs
      .filter((run) => FAILURE_CONCLUSIONS.has((run.conclusion || '').toLowerCase()))
      .map((run) => run.databaseId),
  );
  const openPrNumbers = toSortedNumbers(openPrs.map((entry) => entry.number));
  const openIssueNumbers = toSortedNumbers(openIssues.map((entry) => entry.number));

  const snapshot = {
    repo,
    headSha,
    dirty: porcelainStatus.length > 0,
    openPrNumbers,
    openIssueNumbers,
    failingRunIds,
  };

  return {
    signature: JSON.stringify(snapshot),
    backlogZero:
      openPrNumbers.length === 0 &&
      openIssueNumbers.length === 0 &&
      failingRunIds.length === 0,
  };
}
