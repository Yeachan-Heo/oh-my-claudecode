#!/usr/bin/env node
// Collects exact-head CI evidence for epic #3698 child PRs via `gh` and emits
// the JSON evidence document consumed by scripts/verify-epic-3698-closure.mjs
// (--evidence). Read-only against GitHub; never mutates PRs, branches, or
// releases. Each check is attested at the PR head OID reported by gh at
// collection time; the verifier re-queries GitHub and rejects checks whose
// recorded SHA or status disagrees with the live PR head.
//
// Usage:
//   node scripts/collect-epic-3698-ci-evidence.mjs --prs 3715,3716,3719,3720,3721,3723,3724,3725,3729 --out <path>
//   node scripts/collect-epic-3698-ci-evidence.mjs --all-children --out <path>

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { EPIC_CONTRACT } from './verify-epic-3698-closure.mjs';

function fail(message) {
  process.stderr.write(`collect-epic-3698-ci-evidence: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { prs: null, allChildren: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--prs': {
        const raw = argv[++i];
        if (!raw) fail('--prs requires a comma-separated PR list');
        const values = raw.split(',').map((s) => s.trim());
        if (values.some((value) => !/^\d+$/.test(value))) fail('--prs must contain only positive integer PR numbers');
        args.prs = values.map((value) => Number(value));
        break;
      }
      case '--all-children': args.allChildren = true; break;
      case '--out': args.out = argv[++i]; break;
      default: fail(`unknown argument: ${argv[i]}`);
    }
  }
  if (!args.out) fail('--out is required');
  const modes = Number(args.allChildren) + Number(Array.isArray(args.prs));
  if (modes !== 1) fail('choose exactly one of --prs or --all-children');
  return args;
}

const EXPECTED_CHILD_PR_ENTRIES = Object.entries(EPIC_CONTRACT.childPullRequests)
  .filter(([, number]) => number !== null)
  .map(([issue, number]) => ({ issue: Number(issue), number }));
const EXPECTED_PR_NUMBERS = new Set(EXPECTED_CHILD_PR_ENTRIES.map(({ number }) => number));

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function ghPaginated(path, field) {
  const records = [];
  let totalCount = null;
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = ghJson(['api', `${path}${separator}per_page=100&page=${page}`, '--header', 'Accept: application/vnd.github+json']);
    const batch = Array.isArray(response) ? response : response?.[field] ?? [];
    if (!Array.isArray(batch)) fail(`${path} did not return a ${field} array`);
    if (Number.isSafeInteger(response?.total_count)) totalCount = response.total_count;
    records.push(...batch);
    if (batch.length < 100) break;
    if (page >= 100) fail(`${path} exceeded the bounded pagination limit`);
  }
  if (totalCount !== null && records.length !== totalCount) {
    fail(`${path} pagination returned ${records.length} of ${totalCount} records`);
  }
  return records;
}

const COMPLETED_CONCLUSIONS = new Set([
  'success', 'skipped', 'neutral', 'failure', 'cancelled', 'timed_out',
  'action_required', 'stale', 'startup_failure',
]);

function collectCompletedCheck(record, headSha, label) {
  const name = record.workflowName ? `${record.workflowName} / ${record.name}` : (record.context ?? record.name);
  const conclusion = String(record.conclusion ?? record.state ?? '').toLowerCase();
  if (record.status !== undefined && record.status !== 'completed') {
    fail(`${label} is not completed (status: ${record.status})`);
  }
  if (!name || !COMPLETED_CONCLUSIONS.has(conclusion)) {
    fail(`${label} has no completed GitHub conclusion`);
  }
  return { name, conclusion, sha: headSha };
}

function collectPr(issue, number, repository) {
  const childIssue = ghJson(['issue', 'view', String(issue), '--json', 'number,state']);
  if (childIssue.number !== issue || childIssue.state !== 'CLOSED') fail(`expected child issue #${issue} is not live and CLOSED while collecting PR #${number}`);
  const pr = ghJson(['api', `repos/${repository}/pulls/${number}`, '--header', 'Accept: application/vnd.github+json']);
  if (pr.number !== number) fail(`gh returned PR #${pr.number} while collecting expected PR #${number} for child issue #${issue}`);
  if (pr.state !== 'closed' || !pr.merged_at) fail(`expected PR #${number} for child issue #${issue} is not merged (state: ${pr.state ?? 'missing'})`);
  if (typeof pr.head?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(pr.head.sha)) {
    fail(`PR #${number} for child issue #${issue} has no valid exact head SHA`);
  }
  const checkRuns = ghPaginated(`repos/${repository}/commits/${pr.head.sha}/check-runs`, 'check_runs');
  const statuses = ghPaginated(`repos/${repository}/commits/${pr.head.sha}/statuses`, 'statuses');
  const checks = [...new Map([...checkRuns, ...statuses]
    .map((check, index) => collectCompletedCheck(check, pr.head.sha, `PR #${number} check[${index}]`))
    .map((check) => [`${check.name}\u0000${check.conclusion}\u0000${check.sha}`, check])).values()];
  if (checks.length === 0) fail(`merged PR #${number} for child issue #${issue} has no completed status checks`);

  const mergeCommitSha = pr.merge_commit_sha;
  if (typeof mergeCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(mergeCommitSha)) {
    fail(`merged PR #${number} for child issue #${issue} has no valid merge commit SHA`);
  }
  if (typeof pr.base?.ref !== 'string' || pr.base.ref.length === 0 || !/^[0-9a-f]{40}$/.test(pr.base?.sha ?? '')) {
    fail(`merged PR #${number} for child issue #${issue} has no authenticated base ref/OID`);
  }
  return {
    childIssue: issue,
    number: pr.number,
    headSha: pr.head.sha,
    mergeCommitSha,
    state: 'MERGED',
    checks,
    baseRefName: pr.base.ref,
    baseRefOid: pr.base.sha,
  };
}

function collectDirectIssue(issue, repository, verificationHead) {
  const issueData = ghJson(['issue', 'view', String(issue), '--json', 'number,state']);
  if (issueData.number !== issue) fail(`gh returned issue #${issueData.number} while collecting expected issue #${issue}`);
  if (issueData.state !== 'CLOSED') fail(`expected direct issue #${issue} is not closed (state: ${issueData.state ?? 'missing'})`);

  const timelinePath = `repos/${repository}/issues/${issue}/timeline`;
  const timeline = ghPaginated(timelinePath, 'timeline');
  const commitEvent = timeline
    .map((event) => ({
      eventType: event.event,
      sha: event.event === 'referenced' ? event.commit_id : null,
    }))
    .filter((event) => typeof event.sha === 'string' && /^[0-9a-f]{40}$/.test(event.sha))
    .at(-1);
  if (!commitEvent) fail(`direct issue #${issue} has no independently referenced commit in its timeline`);

  const commitPath = `repos/${repository}/commits/${commitEvent.sha}`;
  const commit = ghJson(['api', commitPath, '--header', 'Accept: application/vnd.github+json']);
  if (commit.sha !== commitEvent.sha) fail(`direct issue #${issue} commit endpoint does not match ${commitEvent.sha}`);

  const status = ghJson([
    'api',
    `${commitPath}/status`,
    '--header',
    'Accept: application/vnd.github+json',
  ]);
  if (status.sha !== commitEvent.sha) fail(`direct issue #${issue} status SHA does not match commit ${commitEvent.sha}`);

  const statusesPath = `${commitPath}/statuses`;
  const statuses = ghPaginated(statusesPath, 'statuses').map((legacy) => ({
    context: legacy.context,
    state: String(legacy.state ?? '').toLowerCase(),
    sha: legacy.sha,
  }));
  if (statuses.some((legacy) => legacy.sha !== commitEvent.sha || legacy.state !== 'success' || typeof legacy.context !== 'string' || legacy.context.length === 0)) {
    fail(`direct issue #${issue} commit ${commitEvent.sha} has unresolved or mismatched legacy status contexts`);
  }

  const checksPath = `${commitPath}/check-runs`;
  const checks = ghPaginated(checksPath, 'check_runs').map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: String(check.conclusion ?? '').toLowerCase(),
    head_sha: check.head_sha,
  }));
  if (checks.length === 0 || checks.some((check) => check.head_sha !== commitEvent.sha || check.status !== 'completed' || !['success', 'skipped', 'neutral'].includes(check.conclusion))) {
    fail(`direct issue #${issue} commit ${commitEvent.sha} has incomplete, non-green, or mismatched check runs`);
  }

  const workflowsPath = `repos/${repository}/actions/runs`;
  const workflows = ghPaginated(`${workflowsPath}?head_sha=${commitEvent.sha}`, 'workflow_runs').map((run) => ({
    id: run.id,
    name: run.name,
    path: run.path,
    status: run.status,
    conclusion: String(run.conclusion ?? '').toLowerCase(),
    head_sha: run.head_sha,
  }));
  if (workflows.length === 0 || workflows.some((run) => run.head_sha !== commitEvent.sha || run.status !== 'completed' || !['success', 'skipped', 'neutral'].includes(run.conclusion))) {
    fail(`direct issue #${issue} commit ${commitEvent.sha} has incomplete, non-green, or mismatched workflow runs`);
  }
  if (status.state !== 'success' && !(status.state === 'pending' && statuses.length === 0)) {
    fail(`direct issue #${issue} commit ${commitEvent.sha} is not green (status: ${status.state ?? 'missing'})`);
  }
  const shippingPath = `repos/${repository}/compare/${commitEvent.sha}...${verificationHead}`;
  const shipping = ghJson(['api', `${shippingPath}?per_page=1&page=1`, '--header', 'Accept: application/vnd.github+json']);
  return {
    issue,
    state: issueData.state,
    commit: { sha: commitEvent.sha },
    status: { sha: status.sha, state: status.state },
    statuses,
    checks,
    workflows,
    shipping: {
      headSha: verificationHead,
      status: shipping.status,
      aheadBy: shipping.ahead_by,
      behindBy: shipping.behind_by,
      mergeBaseSha: shipping.merge_base_commit?.sha,
    },
    source: {
      repository,
      issue: `repos/${repository}/issues/${issue}`,
      timeline: `repos/${repository}/issues/${issue}/timeline`,
      eventType: commitEvent.eventType,
      commitId: commitEvent.sha,
      commit: commitPath,
      status: `${commitPath}/status`,
      statuses: statusesPath,
      checks: checksPath,
      workflows: workflowsPath,
      shipping: shippingPath,
    },
  };
}

function findChildPrs() {
  return EXPECTED_CHILD_PR_ENTRIES.map(({ number }) => number);
}

function validateRequestedPrs(numbers) {
  const seen = new Set();
  for (const number of numbers) {
    if (seen.has(number)) fail(`duplicate PR #${number} in --prs`);
    seen.add(number);
    if (!EXPECTED_PR_NUMBERS.has(number)) fail(`unknown PR #${number}; expected exactly ${[...EXPECTED_PR_NUMBERS].join(', ')}`);
  }
  for (const expected of EXPECTED_PR_NUMBERS) {
    if (!seen.has(expected)) fail(`missing expected PR #${expected} from --prs`);
  }
}

const args = parseArgs(process.argv.slice(2));
const numbers = args.allChildren ? findChildPrs() : args.prs;
if (numbers.length === 0) fail('no child PRs found');
validateRequestedPrs(numbers);
const repository = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
if (typeof repository !== 'string' || repository.length === 0) fail('unable to determine repository name for direct issue evidence');
const verificationHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!/^[0-9a-f]{40}$/.test(verificationHead)) fail('unable to determine exact verification HEAD');
const issueByPr = new Map(EXPECTED_CHILD_PR_ENTRIES.map(({ issue, number }) => [number, issue]));
const pullRequests = numbers.map((number) => collectPr(issueByPr.get(number), number, repository));
const directIssues = [collectDirectIssue(3709, repository, verificationHead)];
const evidence = {
  schemaVersion: 1,
  kind: 'ci-evidence',
  issue: 3712,
  createdAt: new Date().toISOString(),
  payload: {
    collector: 'scripts/collect-epic-3698-ci-evidence.mjs (gh pr view statusCheckRollup at headRefOid)',
    repository,
    expectedChildPullRequests: EPIC_CONTRACT.childPullRequests,
    pullRequests,
    directIssues,
  },
};
writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`collected exact-head CI evidence for PR(s): ${numbers.join(', ')}\n`);
