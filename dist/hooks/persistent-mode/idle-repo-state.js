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
function runCommand(command, args, cwd) {
    try {
        return execFileSync(command, args, {
            cwd,
            encoding: 'utf-8',
            timeout: COMMAND_TIMEOUT_MS,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(command === 'git' ? { windowsHide: true } : {}),
        }).trim();
    }
    catch {
        return null;
    }
}
function runJsonCommand(command, args, cwd) {
    const raw = runCommand(command, args, cwd);
    if (raw === null)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function toSortedNumbers(values) {
    return values
        .filter((value) => Number.isInteger(value))
        .sort((left, right) => left - right);
}
export function getIdleNotificationRepoState(directory) {
    const remoteUrl = runCommand('git', ['remote', 'get-url', 'origin'], directory);
    if (!remoteUrl)
        return null;
    const remote = parseRemoteUrl(remoteUrl);
    if (!remote || remote.provider !== 'github')
        return null;
    const repo = `${remote.owner}/${remote.repo}`;
    const headSha = runCommand('git', ['rev-parse', 'HEAD'], directory);
    const porcelainStatus = runCommand('git', ['status', '--porcelain'], directory);
    if (!headSha || porcelainStatus === null)
        return null;
    const openPrs = runJsonCommand('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(MAX_LIST_RESULTS), '--json', 'number'], directory);
    if (!openPrs)
        return null;
    const openIssues = runJsonCommand('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(MAX_LIST_RESULTS), '--json', 'number'], directory);
    if (!openIssues)
        return null;
    const runs = runJsonCommand('gh', ['run', 'list', '--repo', repo, '--limit', String(MAX_LIST_RESULTS), '--json', 'databaseId,conclusion'], directory);
    if (!runs)
        return null;
    const failingRunIds = toSortedNumbers(runs
        .filter((run) => FAILURE_CONCLUSIONS.has((run.conclusion || '').toLowerCase()))
        .map((run) => run.databaseId));
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
        backlogZero: openPrNumbers.length === 0 &&
            openIssueNumbers.length === 0 &&
            failingRunIds.length === 0,
    };
}
//# sourceMappingURL=idle-repo-state.js.map