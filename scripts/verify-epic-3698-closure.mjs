#!/usr/bin/env node
// Epic #3698 closure verifier (child issue #3712).
//
// Verifies the acceptance surface for "Release and installation verification
// and epic closure" without performing any release/tag/publish mutation:
//   1. exact-head CI evidence for the epic's child PRs
//   2. docs/link checks for the closure documentation surface
//   3. shipped metrics vs the epic #3698 quantitative targets
//   4. migration receipts (schema-validated, machine-readable)
//   5. branch/release/security parity (this change set must not mutate
//      release/tag/publish authority)
//   6. child-issue terminality evidence
//   7. explicit remaining-risk register
//
// Exit codes: 0 = every check passed; 2 = no failures but temporal
// prerequisites remain pending; 1 = at least one check failed.
// Pending is honest non-closure evidence: the mechanism is executable now,
// but the epic cannot close while child issues, releases, or the alias
// retirement window (>= 2 minor releases AND >= 90 days, >= 95% canonical
// usage for 2 consecutive releases, zero known critical integrations) are
// unsatisfied.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new VerificationError(message);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

// --- Epic contract configuration (issue #3712 acceptance surface) ---------

export const EPIC_CONTRACT = Object.freeze({
  epic: 3698,
  closureIssue: 3712,
  planningDoc: 'docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md',
  remainingRiskRegister: 'receipts/epic-3698/remaining-risk.json',
  receiptsDir: 'receipts/epic-3698',
  childIssues: Object.freeze([3702, 3703, 3704, 3705, 3706, 3707, 3708, 3709, 3710, 3711]),
  // Every child issue has an explicit expected PR or a null no-dedicated-PR
  // marker. This mapping is shared by the collector and verifier; closure
  // evidence may not substitute an unrelated PR, omit a required PR, or add
  // an unknown PR.
  childPullRequests: Object.freeze({
    3702: 3721,
    3703: 3720,
    3704: 3724,
    3705: 3716,
    3706: 3715,
    3707: 3725,
    3708: 3729,
    // #3709 was closed through coordinated work and has no dedicated PR.
    // Its terminal receipt must carry commit/status evidence directly; an
    // unrelated PR (for example #3727, which closes #3726) is not a substitute.
    3709: null,
    3710: 3719,
    3711: 3723,
  }),
  // Issues whose terminality gates this closure issue per the plan dependency order.
  gateChildren: Object.freeze([3705, 3708, 3709, 3710, 3711]),
  tier0Workflows: Object.freeze(['plan', 'execute', 'review', 'verify']),
  tier0Roles: Object.freeze(['planner', 'executor', 'reviewer', 'verifier']),
  retirementPolicy: Object.freeze({
    minMinorReleases: 2,
    minDays: 90,
    minCanonicalShare: 0.95,
    consecutiveReleases: 2,
    maxCriticalIntegrations: 0,
  }),
  // Paths this epic's change set must never touch (release/tag/publish authority).
  forbiddenChangePatterns: Object.freeze([
    /^\.github\/workflows\/release/,
    /^\.github\/workflows\/.*publish/,
    /^scripts\/release/,
    /^scripts\/sync-version/,
    /^\.npmrc$/,
  ]),
});

const EXPECTED_PR_TO_CHILD = Object.freeze(
  Object.fromEntries(Object.entries(EPIC_CONTRACT.childPullRequests)
    .filter(([, number]) => number !== null)
    .map(([issue, number]) => [number, Number(issue)])),
);

const ALLOWED_RELEASE_SMOKE_DIFF_LINES = Object.freeze([
  '-          test -s "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md"',
  '-          test -f "$SMOKE_PACKAGE_ROOT/skills/setup/SKILL.md"',
  '+          test -s "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md"',
  '-          cmp "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md" "$SMOKE_PROJECT/.claude/skills/omc-reference/SKILL.md"',
  '+          cmp "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md" "$SMOKE_PROJECT/.claude/skills/wiki/SKILL.md"',
]);

function expectedPullRequest(issue) {
  return EPIC_CONTRACT.childPullRequests[issue];
}

// --- Argument parsing ------------------------------------------------------

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    base: 'origin/dev',
    evidence: null,
    receiptsDir: null,
    changedFiles: null,
    jsonOut: null,
    emitMetricsReceipt: null,
    docPaths: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`missing value for ${key}`);
      return argv[i];
    };
    switch (key) {
      case '--root': args.root = resolve(next()); break;
      case '--base': args.base = next(); break;
      case '--evidence': args.evidence = next(); break;
      case '--receipts-dir': args.receiptsDir = next(); break;
      case '--changed-files': args.changedFiles = next(); break;
      case '--json-out': args.jsonOut = next(); break;
      case '--emit-metrics-receipt': args.emitMetricsReceipt = next(); break;
      case '--docs': args.docPaths = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      default: fail(`unknown argument: ${key}`);
    }
  }
  return args;
}

// --- Measurement (public surface separated from internal modules) ----------

function walkFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

export function measureSurface(root) {
  const rel = walkFiles(root).sort();
  const skills = rel.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map((p) => p.split('/')[1]);
  const commands = rel.filter((p) => /^commands\/[^/]+\.md$/.test(p)).map((p) => p.slice('commands/'.length, -3));
  const hookFiles = rel.filter((p) => p.startsWith('src/hooks/'));
  const workflows = rel.filter((p) => p.startsWith('.github/workflows/'));
  const agents = rel.filter((p) => /^src\/agents\/[^/]+\.ts$/.test(p)).map((p) => p.slice('src/agents/'.length, -3));
  return {
    counts: {
      skills: skills.length,
      commands: commands.length,
      hookFiles: hookFiles.length,
      workflows: workflows.length,
      agentDefinitions: agents.length,
    },
    public: { skills, commands, agents },
    measurementSha256: createHash('sha256').update(JSON.stringify(rel)).digest('hex'),
  };
}

// --- Individual checks -----------------------------------------------------
// Each check returns { id, status: 'pass' | 'fail' | 'pending', details, problems }.

function readCiEvidence(evidencePath) {
  if (!evidencePath) return { error: 'no --evidence CI receipt supplied' };
  if (!existsSync(evidencePath)) return { error: `CI evidence file not found: ${evidencePath}` };
  try {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    return { evidence, prs: isObject(evidence) ? evidence.pullRequests ?? evidence.payload?.pullRequests : undefined };
  } catch (error) {
    return { error: `CI evidence is not valid JSON: ${error.message}` };
  }
}

const GREEN_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const COMPLETED_CHECK_CONCLUSIONS = new Set([...GREEN_CHECK_CONCLUSIONS, 'failure', 'cancelled', 'timed_out', 'action_required']);

function normalizeLiveCheck(check, headSha, label) {
  if (!isObject(check)) throw new VerificationError(`${label} must be an object`);
  const name = check.workflowName ? `${check.workflowName} / ${check.name}` : (check.context ?? check.name);
  const conclusion = String(check.conclusion ?? check.state ?? check.status ?? '').toLowerCase();
  if (typeof name !== 'string' || name.length === 0) throw new VerificationError(`${label}.name must be a non-empty string`);
  if (!COMPLETED_CHECK_CONCLUSIONS.has(conclusion)) throw new VerificationError(`${label}.conclusion must be a completed GitHub conclusion, got ${JSON.stringify(conclusion)}`);
  return { name, conclusion, sha: headSha };
}

function normalizeDirectCheck(check, commitSha, label) {
  if (!isObject(check)) throw new VerificationError(`${label} must be an object`);
  const name = check.name ?? check.context;
  const conclusion = String(check.conclusion ?? check.state ?? check.status ?? '').toLowerCase();
  const headSha = check.head_sha ?? check.sha;
  if (!isNonEmptyString(name)) throw new VerificationError(`${label}.name must be a non-empty string`);
  if (headSha !== commitSha) throw new VerificationError(`${label}.head_sha must equal the referenced commit ${commitSha}`);
  if (check.status !== undefined && check.status !== 'completed') {
    throw new VerificationError(`${label}.status must be completed`);
  }
  if (!GREEN_CHECK_CONCLUSIONS.has(conclusion)) {
    throw new VerificationError(`${label}.conclusion must be success|skipped|neutral, got ${JSON.stringify(conclusion)}`);
  }
  return { name, conclusion, sha: commitSha };
}

function normalizeWorkflowRun(run, commitSha, label) {
  if (!isObject(run)) throw new VerificationError(`${label} must be an object`);
  const id = run.id;
  const name = run.name;
  const path = run.path;
  const conclusion = String(run.conclusion ?? '').toLowerCase();
  const headSha = run.head_sha ?? run.sha;
  if (!Number.isSafeInteger(id) || id < 1) throw new VerificationError(`${label}.id must be a positive integer`);
  if (!isNonEmptyString(name)) throw new VerificationError(`${label}.name must be a non-empty string`);
  if (!isNonEmptyString(path)) throw new VerificationError(`${label}.path must be a non-empty string`);
  if (headSha !== commitSha) throw new VerificationError(`${label}.head_sha must equal the referenced commit ${commitSha}`);
  if (run.status !== undefined && run.status !== 'completed') {
    throw new VerificationError(`${label}.status must be completed`);
  }
  if (!GREEN_CHECK_CONCLUSIONS.has(conclusion)) {
    throw new VerificationError(`${label}.conclusion must be success|skipped|neutral, got ${JSON.stringify(conclusion)}`);
  }
  return { id, name, path, conclusion, sha: commitSha };
}

function normalizeLegacyStatus(status, commitSha, label) {
  if (!isObject(status)) throw new VerificationError(`${label} must be an object`);
  const context = status.context;
  const state = String(status.state ?? '').toLowerCase();
  const sha = status.sha;
  if (!isNonEmptyString(context)) throw new VerificationError(`${label}.context must be a non-empty string`);
  if (sha !== commitSha) throw new VerificationError(`${label}.sha must equal the referenced commit ${commitSha}`);
  if (state !== 'success') throw new VerificationError(`${label}.state must be success, got ${JSON.stringify(state)}`);
  return { context, state, sha: commitSha };
}

function apiPath(value) {
  if (!isNonEmptyString(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== 'api.github.com') return null;
    return parsed.pathname.replace(/^\/+/, '');
  } catch {
    return value.replace(/^\/+/, '').split('?')[0];
  }
}

function apiPathMatches(value, expected) {
  const actual = apiPath(value);
  return actual === expected;
}

function normalizeTimelineCommitEvent(event, repository, issue, label) {
  if (!isObject(event)) return null;
  const eventType = event.event;
  const sha = eventType === 'referenced' ? event.commit_id : null;
  if (!isSha(sha)) return null;
  const expectedIssuePath = `repos/${repository}/issues/${issue}`;
  const expectedCommitPath = `repos/${repository}/commits/${sha}`;
  if (event.issue_url !== undefined && !apiPathMatches(event.issue_url, expectedIssuePath)) {
    throw new VerificationError(`${label}.issue_url does not identify ${expectedIssuePath}`);
  }
  if (event.commit_url !== undefined && !apiPathMatches(event.commit_url, expectedCommitPath)) {
    throw new VerificationError(`${label}.commit_url does not identify ${expectedCommitPath}`);
  }
  if (isObject(event.repository) && event.repository.full_name !== undefined && event.repository.full_name !== repository) {
    throw new VerificationError(`${label}.repository does not identify ${repository}`);
  }
  return { event: eventType, sha };
}

function directChecksAreGreen(status, checks, workflows, statuses) {
  if (status?.state === 'success') return true;
  // GitHub can report no legacy commit statuses while the check-runs and
  // workflow-runs APIs are already terminal and green. Treat that shape as
  // authenticated green evidence, but only when both independent APIs agree.
  return status?.state === 'pending'
    && statuses.length === 0
    && checks.length > 0
    && workflows.length > 0
    && checks.every((check) => GREEN_CHECK_CONCLUSIONS.has(check.conclusion))
    && workflows.every((run) => GREEN_CHECK_CONCLUSIONS.has(run.conclusion));
}

function ghPaginated(root, path, field) {
  const records = [];
  let totalCount = null;
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = ghJson(root, ['api', `${path}${separator}per_page=100&page=${page}`, '--header', 'Accept: application/vnd.github+json']);
    const batch = Array.isArray(response) ? response : response?.[field] ?? [];
    if (!Array.isArray(batch)) throw new VerificationError(`${path} did not return a ${field} array`);
    if (Number.isSafeInteger(response?.total_count)) totalCount = response.total_count;
    records.push(...batch);
    if (batch.length < 100) break;
    if (page >= 100) throw new VerificationError(`${path} exceeded the bounded pagination limit`);
  }
  if (totalCount !== null && records.length !== totalCount) {
    throw new VerificationError(`${path} pagination returned ${records.length} of ${totalCount} records`);
  }
  return records;
}

function checkKey(check) {
  return `${check.name}\u0000${check.conclusion}\u0000${check.sha}`;
}

function ghJson(root, args) {
  const out = execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function verifyLiveGitHubEvidence(root, evidence, prs, directIssues) {
  const repository = evidence.repository ?? evidence.payload?.repository;
  if (!isNonEmptyString(repository)) return { error: 'CI evidence must include payload.repository for live GitHub authentication' };
  try {
    const liveRepo = ghJson(root, ['repo', 'view', '--json', 'nameWithOwner']);
    if (!isObject(liveRepo) || liveRepo.nameWithOwner !== repository) {
      return { problems: [`CI evidence repository ${JSON.stringify(repository)} does not match live GitHub repository ${JSON.stringify(liveRepo?.nameWithOwner)}`] };
    }
    let expectedBase = null;
    let verificationHead = null;
    try {
      verificationHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      // Non-git fixtures and incomplete checkouts cannot authenticate a
      // closure-PR base; the independent child evidence remains verifiable.
    }
    if (isSha(verificationHead)) {
      const associatedPulls = ghPaginated(root, `repos/${repository}/commits/${verificationHead}/pulls`, 'pulls');
      const exactHeadPulls = associatedPulls
        .filter((pull) => pull?.head?.sha === verificationHead && pull?.state === 'open');
      if (exactHeadPulls.length > 1) {
        return { problems: [`verification HEAD ${verificationHead} is the head of multiple open pull requests; authenticated expected base is ambiguous`] };
      }
      if (exactHeadPulls.length === 1) {
        const pull = exactHeadPulls[0];
        if (!isNonEmptyString(pull.base?.ref) || !isSha(pull.base?.sha)) {
          return { problems: [`verification HEAD ${verificationHead} has no valid authenticated pull-request base`] };
        }
        expectedBase = { ref: pull.base.ref, sha: pull.base.sha };
      }
    }
    const livePrs = [];
    for (const [index, pr] of prs.entries()) {
      const label = `pullRequests[${index}]`;
      const live = ghJson(root, ['api', `repos/${repository}/pulls/${pr.number}`, '--header', 'Accept: application/vnd.github+json']);
      if (!isObject(live) || live.number !== pr.number) return { problems: [`${label}.number is not bound to live repository PR #${pr.number}`] };
      if (live.state !== 'closed' || !live.merged_at) return { problems: [`${label} live state must be MERGED, got ${JSON.stringify(live.state)}`] };
      if (live.head?.sha !== pr.headSha) return { problems: [`${label}.headSha does not match live PR head ${live.head?.sha}`] };
      if (live.merge_commit_sha !== pr.mergeCommitSha) return { problems: [`${label}.mergeCommitSha does not match live merge commit ${live.merge_commit_sha}`] };
      const liveBaseRefName = live.base?.ref;
      const liveBaseRefOid = live.base?.sha;
      if (!isNonEmptyString(liveBaseRefName) || !isSha(liveBaseRefOid)) {
        return { problems: [`${label}.live baseRefName/baseRefOid is not a valid authenticated PR base`] };
      }
      if (Object.hasOwn(pr, 'baseRefName') && pr.baseRefName !== liveBaseRefName) {
        return { problems: [`${label}.baseRefName does not match live PR base ${liveBaseRefName}`] };
      }
      if (Object.hasOwn(pr, 'baseRefOid') && pr.baseRefOid !== liveBaseRefOid) {
        return { problems: [`${label}.baseRefOid does not match live PR base ${liveBaseRefOid}`] };
      }
      const liveIssue = ghJson(root, ['issue', 'view', String(pr.childIssue), '--json', 'number,state']);
      if (!isObject(liveIssue) || liveIssue.number !== pr.childIssue || liveIssue.state !== 'CLOSED') {
        return { problems: [`${label}.childIssue #${pr.childIssue} is not bound to a live CLOSED issue`] };
      }
      let liveChecks;
      try {
        const checkRuns = ghPaginated(root, `repos/${repository}/commits/${live.head.sha}/check-runs`, 'check_runs');
        const statuses = ghPaginated(root, `repos/${repository}/commits/${live.head.sha}/statuses`, 'statuses');
        liveChecks = [...checkRuns, ...statuses]
          .map((check, checkIndex) => normalizeLiveCheck(check, live.head.sha, `${label}.liveChecks[${checkIndex}]`));
        liveChecks = [...new Map(liveChecks.map((check) => [checkKey(check), check])).values()];
      } catch (error) {
        return { problems: [error.message] };
      }
      const evidenceKeys = new Set(pr.checks.map(checkKey));
      const liveKeys = new Set(liveChecks.map(checkKey));
      if (evidenceKeys.size !== pr.checks.length || liveKeys.size !== liveChecks.length) return { problems: [`${label}.checks contains duplicate status records`] };
      if (evidenceKeys.size !== liveKeys.size || [...liveKeys].some((key) => !evidenceKeys.has(key))) {
        return { problems: [`${label}.checks does not exactly match live successful status checks`] };
      }
      livePrs.push({
        number: live.number,
        childIssue: pr.childIssue,
        headSha: live.head.sha,
        mergeCommitSha: live.merge_commit_sha,
        state: 'MERGED',
        checks: liveChecks,
        baseRefName: liveBaseRefName,
        baseRefOid: liveBaseRefOid,
      });
    }
    const liveDirectIssues = [];
    for (const [index, direct] of directIssues.entries()) {
      const label = `directIssues[${index}]`;
      const liveIssue = ghJson(root, ['issue', 'view', String(direct.issue), '--json', 'number,state']);
      if (!isObject(liveIssue) || liveIssue.number !== direct.issue) return { problems: [`${label}.issue is not bound to live repository issue #${direct.issue}`] };
      if (liveIssue.state !== 'CLOSED' || direct.state !== liveIssue.state) return { problems: [`${label}.state does not match live closed issue state`] };
      const commitSha = direct.commit?.sha;
      const source = direct.source;
      const expectedIssuePath = `repos/${repository}/issues/${direct.issue}`;
      const expectedTimelinePath = `${expectedIssuePath}/timeline`;
      const expectedCommitPath = `repos/${repository}/commits/${commitSha}`;
      const expectedStatusPath = `${expectedCommitPath}/status`;
      const expectedStatusesPath = `${expectedCommitPath}/statuses`;
      const expectedChecksPath = `${expectedCommitPath}/check-runs`;
      const expectedWorkflowsPath = `repos/${repository}/actions/runs`;
      const expectedShippingPath = isSha(verificationHead)
        ? `repos/${repository}/compare/${commitSha}...${verificationHead}`
        : null;
      if (!isObject(source) || source.repository !== repository) {
        return { problems: [`${label}.source.repository must match the live repository`] };
      }
      for (const [field, expected] of [
        ['issue', expectedIssuePath],
        ['timeline', expectedTimelinePath],
        ['commit', expectedCommitPath],
        ['status', expectedStatusPath],
        ['statuses', expectedStatusesPath],
        ['checks', expectedChecksPath],
        ['workflows', expectedWorkflowsPath],
      ]) {
        if (!apiPathMatches(source[field], expected)) {
          return { problems: [`${label}.source.${field} must identify ${expected}`] };
        }
      }
      if (expectedShippingPath && !apiPathMatches(source.shipping, expectedShippingPath)) {
        return { problems: [`${label}.source.shipping must identify ${expectedShippingPath}`] };
      }
      const timeline = ghPaginated(root, expectedTimelinePath, 'timeline');
      let liveCommitEvent = null;
      for (const [eventIndex, event] of (Array.isArray(timeline) ? timeline : []).entries()) {
        let normalized;
        try {
          normalized = normalizeTimelineCommitEvent(event, repository, direct.issue, `${label}.timeline[${eventIndex}]`);
        } catch (error) {
          return { problems: [error.message] };
        }
        if (normalized?.sha === commitSha) liveCommitEvent = normalized;
      }
      if (!liveCommitEvent) return { problems: [`${label}.commit.sha does not match a live issue timeline referenced.commit_id`] };
      if (source.eventType !== 'referenced') {
        return { problems: [`${label}.source.eventType must be referenced`] };
      }
      if (source.commitId !== liveCommitEvent.sha) {
        return { problems: [`${label}.source.commitId does not match the live issue timeline commit`] };
      }
      const liveCommit = ghJson(root, ['api', expectedCommitPath, '--header', 'Accept: application/vnd.github+json']);
      if (!isObject(liveCommit) || liveCommit.sha !== commitSha) {
        return { problems: [`${label}.commit.sha is not bound to the live repository commit`] };
      }
      if (isObject(liveCommit.repository) && liveCommit.repository.full_name !== repository) {
        return { problems: [`${label}.commit repository does not match ${repository}`] };
      }
      const liveStatus = ghJson(root, ['api', expectedStatusPath, '--header', 'Accept: application/vnd.github+json']);
      if (!isObject(liveStatus) || liveStatus.sha !== commitSha || direct.status?.sha !== commitSha || direct.status?.state !== liveStatus.state) {
        return { problems: [`${label}.status does not match the live status for commit ${commitSha}`] };
      }
      if (isObject(liveStatus.repository) && liveStatus.repository.full_name !== repository) {
        return { problems: [`${label}.status repository does not match ${repository}`] };
      }
      let liveStatuses;
      let evidenceStatuses;
      try {
        liveStatuses = ghPaginated(root, expectedStatusesPath, 'statuses')
          .map((status, statusIndex) => normalizeLegacyStatus(status, commitSha, `${label}.liveStatuses[${statusIndex}]`));
        evidenceStatuses = (Array.isArray(direct.statuses) ? direct.statuses : [])
          .map((status, statusIndex) => normalizeLegacyStatus(status, commitSha, `${label}.statuses[${statusIndex}]`));
      } catch (error) {
        return { problems: [error.message] };
      }
      const statusKey = (status) => `${status.context}\u0000${status.state}\u0000${status.sha}`;
      const liveStatusKeys = new Set(liveStatuses.map(statusKey));
      const evidenceStatusKeys = new Set(evidenceStatuses.map(statusKey));
      if (liveStatusKeys.size !== liveStatuses.length || evidenceStatusKeys.size !== evidenceStatuses.length || liveStatusKeys.size !== evidenceStatusKeys.size || [...liveStatusKeys].some((key) => !evidenceStatusKeys.has(key))) {
        return { problems: [`${label}.statuses does not exactly match live legacy status provenance`] };
      }
      let liveChecks;
      try {
        liveChecks = ghPaginated(root, expectedChecksPath, 'check_runs')
          .map((check, checkIndex) => normalizeDirectCheck(check, commitSha, `${label}.liveChecks[${checkIndex}]`));
      } catch (error) {
        return { problems: [error.message] };
      }
      if (liveChecks.length === 0) return { problems: [`${label}.liveChecks must contain at least one completed green check`] };
      let evidenceChecks;
      try {
        evidenceChecks = (Array.isArray(direct.checks) ? direct.checks : [])
          .map((check, checkIndex) => normalizeDirectCheck(check, commitSha, `${label}.checks[${checkIndex}]`));
      } catch (error) {
        return { problems: [error.message] };
      }
      const liveCheckKeys = new Set(liveChecks.map(checkKey));
      const evidenceCheckKeys = new Set(evidenceChecks.map(checkKey));
      if (liveCheckKeys.size !== liveChecks.length || evidenceCheckKeys.size !== evidenceChecks.length || liveCheckKeys.size !== evidenceCheckKeys.size || [...liveCheckKeys].some((key) => !evidenceCheckKeys.has(key))) {
        return { problems: [`${label}.checks does not exactly match live check-run provenance`] };
      }
      let liveWorkflows;
      try {
        liveWorkflows = ghPaginated(root, `${expectedWorkflowsPath}?head_sha=${commitSha}`, 'workflow_runs')
          .map((run, runIndex) => normalizeWorkflowRun(run, commitSha, `${label}.liveWorkflows[${runIndex}]`));
      } catch (error) {
        return { problems: [error.message] };
      }
      if (liveWorkflows.length === 0) return { problems: [`${label}.liveWorkflows must contain at least one completed green workflow run`] };
      let evidenceWorkflows;
      try {
        evidenceWorkflows = (Array.isArray(direct.workflows) ? direct.workflows : [])
          .map((run, runIndex) => normalizeWorkflowRun(run, commitSha, `${label}.workflows[${runIndex}]`));
      } catch (error) {
        return { problems: [error.message] };
      }
      const workflowKey = (run) => `${run.id}\u0000${run.name}\u0000${run.path}\u0000${run.conclusion}\u0000${run.sha}`;
      const liveWorkflowKeys = new Set(liveWorkflows.map(workflowKey));
      const evidenceWorkflowKeys = new Set(evidenceWorkflows.map(workflowKey));
      if (liveWorkflowKeys.size !== liveWorkflows.length || evidenceWorkflowKeys.size !== evidenceWorkflows.length || liveWorkflowKeys.size !== evidenceWorkflowKeys.size || [...liveWorkflowKeys].some((key) => !evidenceWorkflowKeys.has(key))) {
        return { problems: [`${label}.workflows does not exactly match live workflow provenance`] };
      }
      if (!directChecksAreGreen(liveStatus, liveChecks, liveWorkflows, liveStatuses) || !directChecksAreGreen(direct.status, evidenceChecks, evidenceWorkflows, evidenceStatuses)) {
        return { problems: [`${label}.status/check/workflow provenance is not green for commit ${commitSha}`] };
      }
      if (expectedShippingPath) {
        const shipping = ghJson(root, ['api', `${expectedShippingPath}?per_page=1&page=1`, '--header', 'Accept: application/vnd.github+json']);
        const liveShipping = {
          headSha: verificationHead,
          status: shipping?.status,
          aheadBy: shipping?.ahead_by,
          behindBy: shipping?.behind_by,
          mergeBaseSha: shipping?.merge_base_commit?.sha,
        };
        if (
          !isObject(direct.shipping) ||
          JSON.stringify(direct.shipping) !== JSON.stringify(liveShipping) ||
          !['ahead', 'identical'].includes(liveShipping.status) ||
          liveShipping.behindBy !== 0 ||
          liveShipping.mergeBaseSha !== commitSha
        ) {
          return { problems: [`${label}.commit is not proven reachable from exact verification HEAD ${verificationHead}`] };
        }
      }
      liveDirectIssues.push({
        issue: liveIssue.number,
        state: liveIssue.state,
        commit: { sha: commitSha },
        status: { sha: liveStatus.sha, state: liveStatus.state },
        statuses: liveStatuses,
        checks: liveChecks,
        workflows: liveWorkflows,
        shipping: direct.shipping,
        source: direct.source,
      });
    }
    return {
      authenticated: true,
      repository,
      expectedBase,
      prs: livePrs,
      directIssues: liveDirectIssues,
    };
  } catch (error) {
    return { unavailable: true, error: `live GitHub verification unavailable: ${error.message}` };
  }
}

function checkExactHeadCi(root, evidencePath) {
  const id = 'exactHeadCi';
  if (!evidencePath) {
    return {
      id,
      status: 'pending',
      details: 'no --evidence CI receipt supplied; live GitHub-bound exact-head CI evidence is still required',
      problems: [],
    };
  }
  const loaded = readCiEvidence(evidencePath);
  if (loaded.error) return { id, status: 'fail', details: loaded.error, problems: [loaded.error] };
  const evidence = loaded.evidence;
  if (!isObject(evidence)) return { id, status: 'fail', details: 'CI evidence must be an object', problems: ['CI evidence must be an object'], authenticated: false };
  const prs = loaded.prs;
  const directIssues = evidence.directIssues ?? evidence.payload?.directIssues;
  const problems = [];
  const qualityProblems = [];
  if (evidence.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (evidence.kind !== 'ci-evidence') problems.push('kind must be ci-evidence');
  if (evidence.issue !== EPIC_CONTRACT.closureIssue) problems.push(`issue must be ${EPIC_CONTRACT.closureIssue}`);
  if (!isNonEmptyString(evidence.repository ?? evidence.payload?.repository)) problems.push('repository must be a non-empty string for live GitHub authentication');
  if (!Array.isArray(prs) || prs.length === 0) problems.push('pullRequests must be a non-empty array');
  const expectedPrs = new Set(Object.values(EPIC_CONTRACT.childPullRequests).filter((number) => number !== null));
  const seenPrs = new Set();
  for (const [index, pr] of (Array.isArray(prs) ? prs : []).entries()) {
    const label = `pullRequests[${index}]`;
    if (!isObject(pr)) { problems.push(`${label} must be an object`); continue; }
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) {
      problems.push(`${label}.number must be a positive integer`);
    } else {
      if (seenPrs.has(pr.number)) problems.push(`${label}.number duplicates PR #${pr.number}`);
      seenPrs.add(pr.number);
      if (!expectedPrs.has(pr.number)) {
        problems.push(`${label}.number PR #${pr.number} is not an expected child PR`);
      } else if (pr.childIssue !== EXPECTED_PR_TO_CHILD[pr.number]) {
        problems.push(`${label}.childIssue must equal #${EXPECTED_PR_TO_CHILD[pr.number]} for PR #${pr.number}`);
      }
    }
    if (!isSha(pr.headSha)) problems.push(`${label}.headSha must be a 40-char lowercase hex SHA`);
    if (!isSha(pr.mergeCommitSha)) problems.push(`${label}.mergeCommitSha must be a 40-char lowercase hex SHA`);
    if (pr.state !== 'MERGED') problems.push(`${label}.state must be MERGED, got ${JSON.stringify(pr.state)}`);
    if (!Array.isArray(pr.checks) || pr.checks.length === 0) {
      problems.push(`${label}.checks must be a non-empty array (exact-head proof requires at least one check)`);
      continue;
    }
    for (const [ci, check] of pr.checks.entries()) {
      const clabel = `${label}.checks[${ci}]`;
      if (!isObject(check)) { problems.push(`${clabel} must be an object`); continue; }
      try { requiredString(check.name, `${clabel}.name`); } catch (error) { problems.push(error.message); }
      if (Object.hasOwn(check, 'exactHead')) problems.push(`${clabel}.exactHead is unsupported; use live GitHub status binding`);
      if (isSha(check.sha) && isSha(pr.headSha) && check.sha !== pr.headSha) {
        problems.push(`${clabel} ran at ${check.sha}, not the exact PR head ${pr.headSha}`);
      } else if (!isSha(check.sha)) {
        problems.push(`${clabel}.sha must be a 40-char lowercase hex SHA bound to the live PR head`);
      }
      if (!COMPLETED_CHECK_CONCLUSIONS.has(check.conclusion)) {
        problems.push(`${clabel}.conclusion must be a completed GitHub conclusion, got ${JSON.stringify(check.conclusion)}`);
      } else if (!GREEN_CHECK_CONCLUSIONS.has(check.conclusion)) {
        qualityProblems.push(`${clabel}.conclusion is non-green at the exact PR head: ${JSON.stringify(check.conclusion)}`);
      }
    }
  }
  for (const [issue, number] of Object.entries(EPIC_CONTRACT.childPullRequests)) {
    if (number === null) continue;
    if (!seenPrs.has(number)) problems.push(`missing expected PR #${number} for child issue #${issue}`);
  }
  if (Array.isArray(prs) && prs.length !== expectedPrs.size) {
    problems.push(`pullRequests must contain exactly ${expectedPrs.size} expected child PRs`);
  }
  if (!Array.isArray(directIssues) || directIssues.length !== 1) {
    problems.push('directIssues must contain exactly one independently collected direct issue artifact for #3709');
  } else {
    const [direct] = directIssues;
    const label = 'directIssues[0]';
    if (!isObject(direct)) {
      problems.push(`${label} must be an object`);
    } else {
      if (direct.issue !== 3709) problems.push(`${label}.issue must be 3709`);
      if (direct.state !== 'CLOSED') problems.push(`${label}.state must be CLOSED, got ${JSON.stringify(direct.state)}`);
      if (!isObject(direct.commit) || !isSha(direct.commit.sha)) problems.push(`${label}.commit.sha must be a 40-char lowercase hex SHA`);
      if (!isObject(direct.status) || !isSha(direct.status.sha)) {
        problems.push(`${label}.status.sha must be a 40-char lowercase hex SHA`);
      } else if (direct.commit?.sha !== direct.status.sha) {
        problems.push(`${label}.status.sha must equal commit.sha`);
      }
      if (!['success', 'pending'].includes(direct.status?.state)) problems.push(`${label}.status.state must be success|pending, got ${JSON.stringify(direct.status?.state)}`);
      if (!Array.isArray(direct.statuses)) {
        problems.push(`${label}.statuses must be an array of legacy status provenance`);
      } else {
        for (const [statusIndex, status] of direct.statuses.entries()) {
          try { normalizeLegacyStatus(status, direct.commit?.sha, `${label}.statuses[${statusIndex}]`); } catch (error) { problems.push(error.message); }
        }
      }
      if (!Array.isArray(direct.checks) || direct.checks.length === 0) {
        problems.push(`${label}.checks must contain completed check-run provenance`);
      } else {
        for (const [checkIndex, check] of direct.checks.entries()) {
          try { normalizeDirectCheck(check, direct.commit?.sha, `${label}.checks[${checkIndex}]`); } catch (error) { problems.push(error.message); }
        }
      }
      if (!Array.isArray(direct.workflows) || direct.workflows.length === 0) {
        problems.push(`${label}.workflows must contain completed workflow-run provenance`);
      } else {
        for (const [runIndex, run] of direct.workflows.entries()) {
          try { normalizeWorkflowRun(run, direct.commit?.sha, `${label}.workflows[${runIndex}]`); } catch (error) { problems.push(error.message); }
        }
      }
      if (!isObject(direct.source) || !isNonEmptyString(direct.source.repository)
        || !isNonEmptyString(direct.source.issue) || !isNonEmptyString(direct.source.timeline)
        || !isNonEmptyString(direct.source.commit) || !isNonEmptyString(direct.source.status)
        || !isNonEmptyString(direct.source.statuses) || !isNonEmptyString(direct.source.checks) || !isNonEmptyString(direct.source.workflows)
        || !isNonEmptyString(direct.source.shipping)
        || direct.source.eventType !== 'referenced' || direct.source.commitId !== direct.commit?.sha) {
        problems.push(`${label}.source must identify repository, issue, timeline, commit, status, check, and workflow API evidence`);
      }
      if (!isObject(direct.shipping) || !isSha(direct.shipping.headSha) || !isSha(direct.shipping.mergeBaseSha)
        || !Number.isSafeInteger(direct.shipping.aheadBy) || !Number.isSafeInteger(direct.shipping.behindBy)
        || !isNonEmptyString(direct.shipping.status)) {
        problems.push(`${label}.shipping must identify the exact verification head and compare result`);
      } else {
        const repository = evidence.repository ?? evidence.payload?.repository;
        const expectedShipping = `repos/${repository}/compare/${direct.commit?.sha}...${direct.shipping.headSha}`;
        if (!apiPathMatches(direct.source?.shipping, expectedShipping)) {
          problems.push(`${label}.source.shipping must identify ${expectedShipping}`);
        }
      }
    }
  }
  if (problems.length > 0) {
    return { id, status: 'fail', details: `${problems.length + qualityProblems.length} exact-head CI problem(s)`, problems: [...problems, ...qualityProblems], authenticated: false };
  }
  if (!Array.isArray(directIssues) || directIssues.length === 0) return { id, status: 'fail', details: 'direct issue evidence is required for no-PR child closure authentication', problems: ['missing direct issue evidence'], authenticated: false };
  const live = verifyLiveGitHubEvidence(root, evidence, prs, directIssues);
  if (live.unavailable) return { id, status: 'pending', details: live.error, problems: [live.error], authenticated: false };
  if (live.error) return { id, status: 'fail', details: live.error, problems: [live.error], authenticated: false };
  if (live.problems?.length) return { id, status: 'fail', details: `${live.problems.length} live GitHub evidence problem(s)`, problems: live.problems, authenticated: false };
  if (qualityProblems.length > 0) {
    return { id, status: 'fail', details: `${qualityProblems.length} exact-head CI check(s) are non-green; terminality remains authenticated`, problems: qualityProblems, authenticated: true, evidence, live };
  }
  return { id, status: 'pass', details: `${prs.length} PR(s) and direct issue evidence verified against live GitHub`, problems, authenticated: true, evidence, live };
}

const REFERENCE_LABEL_ESCAPABLE = new Set(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`);

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function findClosingBracket(text, opening) {
  let depth = 1;
  for (let index = opening + 1; index < text.length; index += 1) {
    if (isEscaped(text, index)) continue;
    if (text[index] === '[') depth += 1;
    if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function unescapeReferenceLabel(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && index + 1 < value.length && REFERENCE_LABEL_ESCAPABLE.has(value[index + 1])) {
      result += value[index + 1];
      index += 1;
    } else {
      result += value[index];
    }
  }
  return result;
}

function referenceLabel(value) {
  return value
    .trim()
    .replace(/[ \t\r\n]+/g, ' ')
    .normalize('NFKC')
    .replace(/[ßẞ]/g, 'ss')
    .replace(/ς/g, 'σ')
    .toLowerCase();
}

function commonMarkDestination(value, label, problems, decodePercent) {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  try {
    const unescaped = unescapeReferenceLabel(unwrapped).replace(
      /&(?:#(\d+)|#x([0-9a-f]+)|(period|sol|bsol|amp|lt|gt|quot|apos|percnt|num|colon));/gi,
      (entity, decimal, hexadecimal, named) => {
        if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
        if (hexadecimal !== undefined) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
        return ({ period: '.', sol: '/', bsol: '\\', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", percnt: '%', num: '#', colon: ':' })[named.toLowerCase()] ?? entity;
      },
    );
    if (/&[A-Za-z][A-Za-z0-9]+;/.test(unescaped)) {
      problems.push(`${label} contains an unsupported named character reference`);
      return null;
    }
    return decodePercent ? decodeURIComponent(unescaped) : unescaped;
  } catch {
    problems.push(`${label} contains malformed escaped bytes`);
    return null;
  }
}

function markdownDestination(value, label, problems) {
  return commonMarkDestination(value, label, problems, true);
}

function markdownStructuralDestination(value, label, problems) {
  return commonMarkDestination(value, label, problems, false);
}

function isReferenceDefinitionPosition(text, opening, closing) {
  const lineStart = text.lastIndexOf('\n', opening - 1) + 1;
  const prefix = text.slice(lineStart, opening);
  return /^ {0,3}$/.test(prefix) && text[closing + 1] === ':';
}

function readInlineDestination(text, start) {
  let index = start;
  while (/[ \t\r\n]/.test(text[index] ?? '')) index += 1;
  if (text[index] === '<') {
    for (let end = index + 1; end < text.length; end += 1) {
      if (text[end] === '>' && !isEscaped(text, end)) {
        return { target: text.slice(index + 1, end), end };
      }
    }
    return null;
  }
  const destinationStart = index;
  let depth = 0;
  for (; index < text.length; index += 1) {
    if (isEscaped(text, index)) continue;
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (/[ \t\r\n]/.test(text[index]) && depth === 0) {
      break;
    }
  }
  return index === destinationStart ? null : { target: text.slice(destinationStart, index), end: index };
}

function stripMarkdownContainerPrefix(line) {
  let content = line;
  for (;;) {
    const blockQuote = content.match(/^ {0,3}>[ \t]?/);
    if (blockQuote) {
      content = content.slice(blockQuote[0].length);
      continue;
    }
    const listItem = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/);
    if (listItem) {
      content = content.slice(listItem[0].length);
      continue;
    }
    break;
  }
  return content;
}

function blockQuotePrefix(line) {
  let offset = 0;
  let depth = 0;
  for (;;) {
    const match = line.slice(offset).match(/^ {0,3}>[ \t]?/);
    if (!match) return { offset, depth };
    offset += match[0].length;
    depth += 1;
  }
}

function indentation(line) {
  let index = 0;
  let columns = 0;
  while (index < line.length) {
    if (line[index] === ' ') columns += 1;
    else if (line[index] === '\t') columns += 4 - (columns % 4);
    else break;
    index += 1;
  }
  return { index, columns };
}

function indexAfterColumns(line, targetColumns) {
  let index = 0;
  let columns = 0;
  while (index < line.length && columns < targetColumns) {
    if (line[index] === ' ') columns += 1;
    else if (line[index] === '\t') columns += 4 - (columns % 4);
    else break;
    index += 1;
  }
  return columns >= targetColumns ? index : 0;
}

function columnWidth(value) {
  let columns = 0;
  for (const char of value) {
    columns += char === '\t' ? 4 - (columns % 4) : 1;
  }
  return columns;
}

function maskTextButPreserveRawHtmlTags(line) {
  const chars = line.split('');
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== '<') {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
      continue;
    }
    let quote = null;
    let closing = index + 1;
    for (; closing < chars.length; closing += 1) {
      const char = chars[closing];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (closing >= chars.length || quote) {
      chars[index] = ' ';
      continue;
    }
    index = closing;
  }
  return chars.join('');
}

export function maskCommonMarkCodeBlocks(text) {
  const parts = text.split(/(\r\n?|\n)/);
  let fence = null;
  let htmlBlock = null;
  const listIndents = [];
  const listItemIds = [];
  let nextListItemId = 1;
  let paragraphChain = null;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
    const line = parts[partIndex];
    if (line.trim() === '') {
      paragraphChain = null;
      if (fence?.containerChain.split('/').includes('quote')) fence = null;
      else if (fence) parts[partIndex] = ' '.repeat(line.length);
      continue;
    }
    let quoteDepth = 0;
    let content = line;
    let contentOffset = 0;
    let baseIndent = 0;
    const containerChain = [];
    const activeListIndent = listIndents[listIndents.length - 1] ?? 0;
    if (activeListIndent > 0 && indentation(content).columns >= activeListIndent) {
      const baseIndex = indexAfterColumns(content, activeListIndent);
      contentOffset += baseIndex;
      content = content.slice(baseIndex);
      baseIndent = activeListIndent;
      containerChain.push(...listItemIds.map((id) => `list:${id}`));
    } else {
      const initialQuote = blockQuotePrefix(content);
      quoteDepth += initialQuote.depth;
      containerChain.push(...Array(initialQuote.depth).fill('quote'));
      contentOffset += initialQuote.offset;
      content = content.slice(initialQuote.offset);

      const leading = indentation(content);
      while (listIndents.length > 0 && leading.columns < listIndents[listIndents.length - 1]) {
        listIndents.pop();
        listItemIds.pop();
      }
      baseIndent = listIndents[listIndents.length - 1] ?? 0;
      containerChain.push(...listItemIds.map((id) => `list:${id}`));
      if (baseIndent > 0) {
        const baseIndex = indexAfterColumns(content, baseIndent);
        if (baseIndex > 0) {
          contentOffset += baseIndex;
          content = content.slice(baseIndex);
        }
      }
    }

    for (;;) {
      const currentChain = containerChain.join('/');
      const paragraphActive = paragraphChain === currentChain;
      const list = content.match(/^([ \t]{0,3})([-+*]|(\d{1,9})[.)])([ \t]+)/);
      if (list && paragraphActive && list[3] !== undefined && list[3] !== '1') break;
      if (list) {
        const markerColumns = columnWidth(list[0]);
        const parentIndent = listIndents[listIndents.length - 1] ?? baseIndent;
        listIndents.push(parentIndent + markerColumns);
        const itemId = nextListItemId;
        nextListItemId += 1;
        listItemIds.push(itemId);
        containerChain.push(`list:${itemId}`);
        contentOffset += list[0].length;
        content = content.slice(list[0].length);
      }
      const nestedQuote = blockQuotePrefix(content);
      if (nestedQuote.offset > 0) {
        quoteDepth += nestedQuote.depth;
        containerChain.push(...Array(nestedQuote.depth).fill('quote'));
        contentOffset += nestedQuote.offset;
        content = content.slice(nestedQuote.offset);
      }
      if (!list && nestedQuote.offset === 0) break;
    }
    if (fence && containerChain.join('/') !== fence.containerChain) fence = null;
    if (htmlBlock && containerChain.join('/') !== htmlBlock.containerChain) htmlBlock = null;
    const currentChain = containerChain.join('/');
    const paragraphActive = paragraphChain === currentChain;
    if (content.trim() === '') {
      if (fence) parts[partIndex] = ' '.repeat(line.length);
      continue;
    }

    if (htmlBlock) {
      paragraphChain = null;
      parts[partIndex] = htmlBlock.tag === 'pre'
        ? maskTextButPreserveRawHtmlTags(line)
        : ' '.repeat(line.length);
      if (new RegExp(`</${htmlBlock.tag}[ \\t\\r\\n]*>`, 'i').test(content)) htmlBlock = null;
      continue;
    }

    const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      paragraphChain = null;
      parts[partIndex] = ' '.repeat(line.length);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ''
      ) fence = null;
      continue;
    }
    const htmlBlockStart = content.match(/^ {0,3}<(script|pre|style|textarea)(?:[ \t\r\n]|>)/i);
    if (htmlBlockStart) {
      const tagName = htmlBlockStart[1].toLowerCase();
      let quote = null;
      let openingEnd = content.indexOf('<') + 1 + tagName.length;
      for (; openingEnd < content.length; openingEnd += 1) {
        const char = content[openingEnd];
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '>') break;
      }
      if (openingEnd < content.length && !quote) {
        paragraphChain = null;
        const before = line.slice(0, contentOffset + openingEnd + 1);
        parts[partIndex] = tagName === 'pre'
          ? before + maskTextButPreserveRawHtmlTags(line.slice(before.length))
          : before + ' '.repeat(line.length - before.length);
        const afterOpening = content.slice(openingEnd + 1);
        if (!new RegExp(`</${tagName}[ \\t\\r\\n]*>`, 'i').test(afterOpening)) {
          htmlBlock = { tag: tagName, containerChain: containerChain.join('/') };
        }
        continue;
      }
    }
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      paragraphChain = null;
      fence = {
        char: fenceMatch[1][0],
        length: fenceMatch[1].length,
        quoteDepth,
        listDepth: listIndents.length,
        containerChain: containerChain.join('/'),
      };
      parts[partIndex] = ' '.repeat(line.length);
      continue;
    }
    if (indentation(content).columns >= 4 && !paragraphActive) {
      paragraphChain = null;
      parts[partIndex] = ' '.repeat(line.length);
      continue;
    }
    if (contentOffset > 0) parts[partIndex] = ' '.repeat(contentOffset) + line.slice(contentOffset);
    paragraphChain = /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(content) ? null : currentChain;
  }
  return parts.join('');
}

function maskInlineCodeAndExtractHtml(text, problems, docPath) {
  const chars = text.split('');
  const targets = [];
  const urlAttributes = new Set([
    'href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'poster', 'cite', 'data',
    'background', 'longdesc', 'usemap', 'manifest', 'profile',
  ]);
  for (let opening = 0; opening < chars.length; opening += 1) {
    if (chars[opening] === '`' && !isEscaped(text, opening)) {
      let runLength = 1;
      while (chars[opening + runLength] === '`') runLength += 1;
      let closing = opening + runLength;
      while (closing < chars.length) {
        if (chars[closing] !== '`') {
          closing += 1;
          continue;
        }
        let closingLength = 1;
        while (chars[closing + closingLength] === '`') closingLength += 1;
        if (closingLength === runLength) break;
        closing += closingLength;
      }
      if (closing >= chars.length) {
        opening += runLength - 1;
        continue;
      }
      for (let cursor = opening; cursor < closing + runLength; cursor += 1) {
        if (chars[cursor] !== '\r' && chars[cursor] !== '\n') chars[cursor] = ' ';
      }
      opening = closing + runLength - 1;
      continue;
    }
    if (
      chars[opening] !== '<' ||
      isEscaped(text, opening) ||
      !/[A-Za-z]/.test(chars[opening + 1] ?? '')
    ) continue;
    let quote = null;
    let closing = opening + 2;
    for (; closing < chars.length; closing += 1) {
      const char = chars[closing];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (closing >= chars.length || quote) {
      problems.push(`${docPath}: unterminated raw HTML tag is unsupported`);
      break;
    }
    const body = chars.slice(opening, closing + 1).join('');
    if (!/^<[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*'|[^ \t\r\n"'=<>`]+))?)*[ \t\r\n]*\/?>$/s.test(body)) {
      problems.push(`${docPath}: malformed raw HTML tag is unsupported`);
      continue;
    }
    const attributes = body.matchAll(/\b([A-Za-z_:][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)'|([^ \t\r\n"'=<>`]+))/g);
    for (const attribute of attributes) {
      const name = attribute[1].toLowerCase();
      if (!urlAttributes.has(name)) continue;
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      if (name === 'srcset') {
        for (const candidate of value.split(',')) {
          const url = candidate.trim().split(/[ \t\r\n]+/, 1)[0];
          if (url) targets.push(url);
        }
      } else if (value) {
        targets.push(value);
      }
    }
    for (let cursor = opening; cursor <= closing; cursor += 1) {
      if (chars[cursor] !== '\r' && chars[cursor] !== '\n') chars[cursor] = ' ';
    }
    opening = closing;
  }
  return { text: chars.join(''), targets };
}

function parseMarkdownDestinations(text, problems, docPath) {
  const definitions = new Map();
  const blockMaskedText = maskCommonMarkCodeBlocks(text);
  const inline = maskInlineCodeAndExtractHtml(blockMaskedText, problems, docPath);
  const htmlTargets = inline.targets;
  const definitionText = inline.text;
  const lines = definitionText.split(/\r\n?|\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = stripMarkdownContainerPrefix(lines[lineIndex]);
    const leading = line.match(/^ {0,3}/)?.[0].length ?? 0;
    if (line[leading] !== '[') continue;
    const closing = findClosingBracket(line, leading);
    if (closing < 0 || line[closing + 1] !== ':') continue;
    let rest = line.slice(closing + 2).trimStart();
    if (!rest && lineIndex + 1 < lines.length) {
      rest = stripMarkdownContainerPrefix(lines[lineIndex + 1]).trimStart();
    }
    const label = referenceLabel(line.slice(leading + 1, closing));
    if (!rest) {
      problems.push(`${docPath}: unsupported or missing destination for reference definition [${label}]`);
      continue;
    }
    const destination = readInlineDestination(rest, 0);
    if (!destination) {
      problems.push(`${docPath}: unsupported destination for reference definition [${label}]`);
      continue;
    }
    if (!definitions.has(label)) definitions.set(label, destination.target);
  }
  const targets = [];
  const potentialDefinitionTargets = new Set();
  for (let opening = 0; opening < definitionText.length; opening += 1) {
    if (definitionText[opening] !== '[' || isEscaped(definitionText, opening)) continue;
    const closing = findClosingBracket(definitionText, opening);
    if (closing < 0 || definitionText[closing + 1] !== ':') continue;
    const destination = readInlineDestination(definitionText, closing + 2);
    if (!destination) {
      problems.push(`${docPath}: unsupported or missing destination for potential reference definition`);
      continue;
    }
    const label = referenceLabel(definitionText.slice(opening + 1, closing));
    if (!definitions.has(label)) definitions.set(label, destination.target);
    potentialDefinitionTargets.add(destination.target);
  }
  for (let index = 0; index < definitionText.length; index += 1) {
    if (definitionText[index] !== '[' || isEscaped(definitionText, index)) continue;
    const firstClosing = findClosingBracket(definitionText, index);
    if (firstClosing < 0) continue;
    if (isReferenceDefinitionPosition(definitionText, index, firstClosing)) {
      index = firstClosing;
      continue;
    }
    const firstLabel = definitionText.slice(index + 1, firstClosing);
    const next = definitionText[firstClosing + 1];
    if (next === '(') {
      const destination = readInlineDestination(definitionText, firstClosing + 2);
      if (destination) targets.push(destination.target);
      index = destination?.end ?? firstClosing;
      continue;
    }
    if (next === '[') {
      const secondClosing = findClosingBracket(definitionText, firstClosing + 1);
      if (secondClosing < 0) continue;
      const secondLabel = definitionText.slice(firstClosing + 2, secondClosing);
      const label = referenceLabel(secondLabel || firstLabel);
      const target = definitions.get(label);
      if (target === undefined) problems.push(`${docPath}: missing reference definition [${secondLabel || firstLabel}]`);
      else targets.push(target);
      index = secondClosing;
      continue;
    }
    const target = definitions.get(referenceLabel(firstLabel));
    if (target !== undefined) targets.push(target);
    index = firstClosing;
  }
  for (const target of definitions.values()) targets.push(target);
  for (const target of potentialDefinitionTargets) targets.push(target);
  targets.push(...htmlTargets);
  return targets;
}

function isPathWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalPathWithinRoot(root, candidate, label, problems) {
  if (!isPathWithin(root, candidate)) {
    problems.push(`${label} escapes repository root`);
    return null;
  }
  let canonical;
  try {
    canonical = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!isPathWithin(root, canonical)) {
    problems.push(`${label} resolves outside repository root`);
    return null;
  }
  return canonical;
}

function checkDocsLinks(root, docPaths) {
  const id = 'docsLinks';
  const problems = [];
  let scanned = 0;
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch (error) {
    return { id, status: 'fail', details: `repository root is not readable: ${error.message}`, problems: ['unreadable repository root'] };
  }
  for (const docPath of docPaths) {
    const absolute = resolve(canonicalRoot, docPath);
    if (!isPathWithin(canonicalRoot, absolute)) {
      problems.push(`document ${docPath} escapes repository root`);
      continue;
    }
    if (!existsSync(absolute)) {
      // The planning doc lives on the planning branch until PR #3701 merges;
      // a missing doc that is not owned by this issue is pending, not broken.
      if (docPath === EPIC_CONTRACT.planningDoc) continue;
      problems.push(`document not found: ${docPath}`);
      continue;
    }
    const canonicalDoc = canonicalPathWithinRoot(canonicalRoot, absolute, `document ${docPath}`, problems);
    if (!canonicalDoc) continue;
    scanned += 1;
    let text;
    try {
      text = readFileSync(canonicalDoc, 'utf8');
    } catch (error) {
      problems.push(`document ${docPath} is not readable: ${error.message}`);
      continue;
    }
    const targets = parseMarkdownDestinations(text, problems, docPath);
    for (const rawTarget of targets) {
      const structuralTarget = markdownStructuralDestination(rawTarget, `${docPath}: link ${rawTarget}`, problems);
      if (structuralTarget === null) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(structuralTarget) || structuralTarget.startsWith('#')) continue;
      if (structuralTarget.startsWith('//')) continue;
      const target = markdownDestination(rawTarget, `${docPath}: link ${rawTarget}`, problems);
      if (target === null) continue;
      const cleaned = structuralTarget.includes('#') ? target.split('#')[0] : target;
      if (!cleaned) continue;
      const resolved = resolve(join(canonicalDoc, '..'), cleaned);
      const canonicalTarget = canonicalPathWithinRoot(canonicalRoot, resolved, `${docPath}: link ${target}`, problems);
      if (!canonicalTarget && isPathWithin(canonicalRoot, resolved)) {
        if (!existsSync(resolved)) problems.push(`${docPath}: broken relative link ${target}`);
      }
    }
  }
  if (scanned === 0) return { id, status: 'pending', details: 'no closure documents present to scan yet', problems };
  return problems.length === 0
    ? { id, status: 'pass', details: `${scanned} document(s) scanned, all relative links resolve`, problems }
    : { id, status: 'fail', details: `${problems.length} broken link(s)`, problems };
}

// Metric definitions: predicate over the measured surface plus the child
// issues that own the target. A missed target is `pending` while any owning
// child lacks terminal evidence and `fail` once every owner is terminal.
const METRICS = [
  {
    id: 'tier0WorkflowSkills',
    owners: [3703, 3705, 3708, 3710],
    describe: 'exactly the Tier-0 workflows plan/execute/review/verify exist as workflow skills',
    evaluate: (m) => EPIC_CONTRACT.tier0Workflows.every((w) => m.public.skills.includes(w)),
  },
  {
    id: 'tier0Roles',
    owners: [3703, 3705, 3708],
    describe: 'Tier-0 role agents planner/executor/reviewer/verifier are defined',
    evaluate: (m) => EPIC_CONTRACT.tier0Roles.every((r) => m.public.agents.includes(r)),
  },
  {
    id: 'commandEntrypoints',
    owners: [3703, 3705, 3708, 3710],
    describe: 'command entrypoints reduced to 12-18 canonical',
    evaluate: (m) => m.counts.commands >= 12 && m.counts.commands <= 18,
  },
  {
    id: 'githubWorkflows',
    owners: [3709, 3705, 3708],
    describe: 'GitHub workflows reduced to the smallest proven set (target 5, acceptable 5-6)',
    evaluate: (m) => m.counts.workflows >= 5 && m.counts.workflows <= 6,
  },
];

function checkShippedMetrics(measured, terminalChildren) {
  const id = 'shippedMetrics';
  const details = [];
  const problems = [];
  let worst = 'pass';
  for (const metric of METRICS) {
    const met = metric.evaluate(measured);
    if (met) {
      details.push(`${metric.id}: met`);
      continue;
    }
    const ownersTerminal = metric.owners.every((issue) => terminalChildren.has(issue));
    if (ownersTerminal) {
      worst = 'fail';
      problems.push(`${metric.id}: target unmet although owning child issue(s) ${metric.owners.join(', ')} are terminal — ${metric.describe}`);
    } else {
      if (worst === 'pass') worst = 'pending';
      details.push(`${metric.id}: not yet met; awaiting owning child issue(s) ${metric.owners.filter((i) => !terminalChildren.has(i)).join(', ')}`);
    }
  }
  return {
    id,
    status: worst,
    details: details.concat(problems).join('; ') || 'all metrics met',
    problems,
    measured: measured.counts,
  };
}

const RECEIPT_KINDS = new Set(['metrics-snapshot', 'alias-usage', 'ci-evidence', 'child-terminal', 'remaining-risk', 'install-verification']);

function validateReceipt(file, receipt, problems) {
  const label = `receipt ${file}`;
  if (!isObject(receipt)) { problems.push(`${label} must be an object`); return null; }
  if (receipt.schemaVersion !== 1) problems.push(`${label}.schemaVersion must be 1`);
  try { requiredString(receipt.kind, `${label}.kind`); } catch (error) { problems.push(error.message); }
  if (typeof receipt.kind === 'string' && !RECEIPT_KINDS.has(receipt.kind)) {
    problems.push(`${label}.kind must be one of ${[...RECEIPT_KINDS].join(', ')}`);
  }
  if (!Number.isSafeInteger(receipt.issue) || receipt.issue < 1) problems.push(`${label}.issue must be a positive integer`);
  try { requiredString(receipt.createdAt, `${label}.createdAt`); } catch (error) { problems.push(error.message); }
  if (!isObject(receipt.payload)) { problems.push(`${label}.payload must be an object`); return null; }
  if (receipt.kind === 'alias-usage') {
    const p = receipt.payload;
    const policy = EPIC_CONTRACT.retirementPolicy;
    if (typeof p.canonicalShare !== 'number' || p.canonicalShare < 0 || p.canonicalShare > 1) {
      problems.push(`${label}.payload.canonicalShare must be a number in [0,1]`);
    }
    if (!Number.isSafeInteger(p.minorReleases) || p.minorReleases < 0) problems.push(`${label}.payload.minorReleases must be a non-negative integer`);
    if (!Number.isSafeInteger(p.daysSinceDeprecation) || p.daysSinceDeprecation < 0) problems.push(`${label}.payload.daysSinceDeprecation must be a non-negative integer`);
    if (!Number.isSafeInteger(p.consecutiveReleasesAtThreshold) || p.consecutiveReleasesAtThreshold < 0) {
      problems.push(`${label}.payload.consecutiveReleasesAtThreshold must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(p.knownCriticalIntegrations) || p.knownCriticalIntegrations < 0) {
      problems.push(`${label}.payload.knownCriticalIntegrations must be a non-negative integer`);
    }
    const satisfied = problems.length === 0
      && p.minorReleases >= policy.minMinorReleases
      && p.daysSinceDeprecation >= policy.minDays
      && p.canonicalShare >= policy.minCanonicalShare
      && p.consecutiveReleasesAtThreshold >= policy.consecutiveReleases
      && p.knownCriticalIntegrations <= policy.maxCriticalIntegrations;
    return { kind: receipt.kind, issue: receipt.issue, retirementSatisfied: satisfied };
  }
  if (receipt.kind === 'child-terminal') {
    const receiptProblemsStart = problems.length;
    const p = receipt.payload;
    if (!['merged', 'closed'].includes(p.state)) problems.push(`${label}.payload.state must be merged|closed`);
    const expectedPr = expectedPullRequest(receipt.issue);
    if (expectedPr === undefined) problems.push(`${label}.issue ${receipt.issue} is not an expected child issue`);
    const evidence = p.evidence;
    const evidenceSummary = {};
    if (!isObject(evidence)) {
      problems.push(`${label}.payload.evidence must be a structured object with pullRequest, commit, and status evidence`);
    } else {
      const pullRequest = evidence.pullRequest;
      if (expectedPr === null) {
        if (pullRequest !== undefined && pullRequest !== null) {
          problems.push(`${label}.payload.evidence.pullRequest must be omitted for child issue #${receipt.issue}; no dedicated PR is expected`);
        }
        const directIssue = evidence.issue;
        if (!isObject(directIssue)) {
          problems.push(`${label}.payload.evidence.issue must be an object for child issue #${receipt.issue}`);
        } else {
          if (directIssue.number !== receipt.issue) problems.push(`${label}.payload.evidence.issue.number must equal child issue #${receipt.issue}`);
          if (directIssue.state !== 'CLOSED') problems.push(`${label}.payload.evidence.issue.state must be CLOSED`);
          evidenceSummary.issueNumber = directIssue.number;
          evidenceSummary.issueState = directIssue.state;
        }
        evidenceSummary.pullRequest = null;
      } else if (!isObject(pullRequest)) {
        problems.push(`${label}.payload.evidence.pullRequest must be an object`);
      } else {
        try { requiredPositiveInteger(pullRequest.number, `${label}.payload.evidence.pullRequest.number`); } catch (error) { problems.push(error.message); }
        if (!isSha(pullRequest.headSha)) problems.push(`${label}.payload.evidence.pullRequest.headSha must be a 40-char lowercase hex SHA`);
        if (Number.isSafeInteger(pullRequest.number) && pullRequest.number !== expectedPr) {
          problems.push(`${label}.payload.evidence.pullRequest.number ${pullRequest.number} does not match expected PR #${expectedPr} for child issue #${receipt.issue}`);
        }
        if (pullRequest.headSha) evidenceSummary.headSha = pullRequest.headSha;
        if (Number.isSafeInteger(pullRequest.number)) evidenceSummary.pullRequest = pullRequest.number;
      }
      const commit = evidence.commit;
      if (!isObject(commit)) {
        problems.push(`${label}.payload.evidence.commit must be an object`);
      } else if (!isSha(commit.sha)) {
        problems.push(`${label}.payload.evidence.commit.sha must be a 40-char lowercase hex SHA`);
      } else {
        evidenceSummary.commitSha = commit.sha;
      }
      const status = evidence.status;
      if (!isObject(status)) {
        problems.push(`${label}.payload.evidence.status must be an object`);
      } else {
        if (expectedPr === null) {
          if (!['success', 'pending'].includes(status.state)) problems.push(`${label}.payload.evidence.status.state must be success|pending when no dedicated PR is expected`);
        } else if (!COMPLETED_CHECK_CONCLUSIONS.has(status.conclusion)) {
          problems.push(`${label}.payload.evidence.status.conclusion must be a completed GitHub conclusion`);
        }
        if (!isSha(status.sha)) {
          problems.push(`${label}.payload.evidence.status.sha must be a 40-char lowercase hex SHA`);
        } else if (evidenceSummary.headSha && status.sha !== evidenceSummary.headSha) {
          problems.push(`${label}.payload.evidence.status.sha must equal pullRequest.headSha`);
        } else if (expectedPr === null && evidenceSummary.commitSha && status.sha !== evidenceSummary.commitSha) {
          problems.push(`${label}.payload.evidence.status.sha must equal commit.sha when no dedicated PR is expected`);
        }
        evidenceSummary.statusConclusion = status.conclusion;
        evidenceSummary.statusState = status.state;
        evidenceSummary.statusSha = status.sha;
      }
    }
    return {
      kind: receipt.kind,
      issue: receipt.issue,
      state: p.state,
      valid: problems.length === receiptProblemsStart,
      childEvidence: evidenceSummary,
    };
  }
  return { kind: receipt.kind, issue: receipt.issue };
}

function readReceipts(receiptsDir) {
  const receipts = [];
  const problems = [];
  if (!existsSync(receiptsDir)) {
    return { receipts, problems, missing: true };
  }
  for (const file of readdirSync(receiptsDir).filter((f) => f.endsWith('.receipt.json')).sort()) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(receiptsDir, file), 'utf8'));
    } catch (error) {
      problems.push(`receipt ${file} is not valid JSON: ${error.message}`);
      continue;
    }
    const summary = validateReceipt(file, parsed, problems);
    if (summary) receipts.push({ file, ...summary });
  }
  return { receipts, problems, missing: false };
}

function checkMigrationReceipts(receiptsDir) {
  const id = 'migrationReceipts';
  const { receipts, problems, missing } = readReceipts(receiptsDir);
  if (missing) {
    return { id, status: 'pending', details: `receipts directory ${receiptsDir} does not exist yet`, problems };
  }
  if (problems.length > 0) {
    return { id, status: 'fail', details: `${problems.length} receipt problem(s)`, problems };
  }
  if (receipts.length === 0) {
    return { id, status: 'pending', details: 'no migration receipts recorded yet', problems };
  }
  return { id, status: 'pass', details: `${receipts.length} schema-valid receipt(s)`, problems };
}

function checkRetirementPolicy(receiptsDir) {
  const id = 'aliasRetirementPolicy';
  const { receipts, missing } = readReceipts(receiptsDir);
  if (missing || receipts.filter((r) => r.kind === 'alias-usage').length === 0) {
    return {
      id,
      status: 'pending',
      details: 'no alias-usage receipts; retirement requires >= 2 minor releases AND >= 90 days, >= 95% canonical usage for 2 consecutive releases, and zero known critical integrations',
      problems: [],
    };
  }
  const unsatisfied = receipts.filter((r) => r.kind === 'alias-usage' && !r.retirementSatisfied);
  return unsatisfied.length === 0
    ? { id, status: 'pass', details: 'all alias-usage receipts satisfy the retirement policy', problems: [] }
    : {
        id,
        status: 'pending',
        details: `${unsatisfied.length} alias-usage receipt(s) do not yet satisfy the retirement window; aliases must NOT be removed`,
        problems: [],
      };
}

// Returns { files } when the change set is computable, or { unavailable }
// when git/base refs are absent (e.g. shallow CI checkouts). An unavailable
// change set must surface as pending evidence, never as a thrown error that
// empties the machine-readable stdout report.
function normalizeChangedFile(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function gitDiffNames(root, base) {
  const candidates = [base];
  if (!base.startsWith('origin/')) candidates.push(`origin/${base}`);
  for (const candidate of candidates) {
    try {
      const mergeBase = execFileSync('git', ['merge-base', candidate, 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (!isSha(mergeBase)) continue;
      const out = execFileSync('git', ['diff', '--name-status', '-M', mergeBase, 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const files = [];
      for (const line of out.split('\n').filter(Boolean)) {
        const fields = line.split('\t');
        const status = fields.shift() ?? '';
        if (/^[RC]/.test(status) && fields.length >= 2) files.push(fields[0], fields[1]);
        else if (fields.length >= 1) files.push(fields[0]);
      }
      return {
        files: files.map(normalizeChangedFile),
        resolvedBase: candidate,
        mergeBase,
      };
    } catch {
      // try the next base candidate
    }
  }
  return null;
}

function listChangedFiles(root, base, changedFilesArg) {
  if (changedFilesArg) {
    let supplied;
    try {
      supplied = readFileSync(changedFilesArg, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).map(normalizeChangedFile);
    } catch (error) {
      return { files: [], inputError: `unable to read --changed-files input: ${error.message}` };
    }
    const exact = gitDiffNames(root, base);
    return exact
      ? { files: supplied, exactFiles: exact.files, resolvedBase: exact.resolvedBase, mergeBase: exact.mergeBase }
      : { files: supplied, suppliedOnly: true };
  }
  const exact = gitDiffNames(root, base);
  return exact ?? { unavailable: true };
}

function isAllowedReleaseSmokeParityDiff(root, mergeBase) {
  if (!isSha(mergeBase)) return false;
  try {
    const diff = execFileSync(
      'git',
      ['diff', '--unified=0', mergeBase, 'HEAD', '--', '.github/workflows/release.yml'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const changed = diff.split('\n').filter((line) => (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ));
    return changed.length === ALLOWED_RELEASE_SMOKE_DIFF_LINES.length &&
      ALLOWED_RELEASE_SMOKE_DIFF_LINES.every((line) => changed.includes(line));
  } catch {
    return false;
  }
}

function checkReleaseSecurityParity(root, base, changedFilesArg, authenticatedBase) {
  const id = 'releaseSecurityParity';
  const problems = [];
  const changeSet = listChangedFiles(root, base, changedFilesArg);
  if (changeSet.unavailable) {
    return {
      id,
      status: 'pending',
      details: `change set unavailable (no usable git base among ${[base, ...(base.startsWith('origin/') ? [] : [`origin/${base}`])].join(', ')}); run with --changed-files or a fetchable base ref to prove release/security parity`,
      problems,
    };
  }
  if (changeSet.inputError) problems.push(changeSet.inputError);
  if (changeSet.mergeBase && !authenticatedBase) {
    return {
      id,
      status: 'pending',
      details: 'authenticated exact-head pull-request base is unavailable; release/security parity cannot pass from a caller-selected Git base',
      problems: ['authenticated expected merge base unavailable'],
    };
  }
  if (authenticatedBase) {
    let expectedMergeBase = null;
    try {
      expectedMergeBase = execFileSync(
        'git',
        ['merge-base', authenticatedBase.sha, 'HEAD'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    } catch {
      // A shallow checkout may not contain the authenticated base object.
    }
    if (!isSha(expectedMergeBase)) {
      return {
        id,
        status: 'pending',
        details: `authenticated ${authenticatedBase.ref} base ${authenticatedBase.sha} is unavailable locally; fetch it before proving release/security parity`,
        problems: [`unable to resolve authenticated expected merge base from ${authenticatedBase.sha}`],
      };
    }
    if (changeSet.mergeBase !== expectedMergeBase) {
      problems.push(`selected base ${base} resolves to merge base ${changeSet.mergeBase ?? 'unavailable'}, but authenticated expected merge base is ${expectedMergeBase}`);
    }
  }
  const suppliedFiles = [...new Set(changeSet.files)];
  const exactFiles = changeSet.exactFiles ? [...new Set(changeSet.exactFiles)] : null;
  if (exactFiles) {
    const suppliedSet = new Set(suppliedFiles);
    const exactSet = new Set(exactFiles);
    const omitted = exactFiles.filter((file) => !suppliedSet.has(file));
    const extra = suppliedFiles.filter((file) => !exactSet.has(file));
    if (omitted.length > 0 || extra.length > 0) {
      problems.push(`--changed-files does not match exact git diff (omitted: ${omitted.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
    }
  }
  const files = exactFiles ?? suppliedFiles;
  for (const file of files) {
    for (const pattern of EPIC_CONTRACT.forbiddenChangePatterns) {
      if (!pattern.test(file)) continue;
      if (
        file === '.github/workflows/release.yml' &&
        isAllowedReleaseSmokeParityDiff(root, changeSet.mergeBase)
      ) {
        continue;
      }
      problems.push(`change set touches release/publish authority surface: ${file}`);
    }
  }
  if (changeSet.suppliedOnly) {
    if (problems.length > 0) {
      return { id, status: 'fail', details: `${problems.length} release/security parity violation(s)`, problems };
    }
    return {
      id,
      status: 'pending',
      details: 'changed-files input is unauthenticated because no exact Git base/head diff is available; parity cannot be established from caller-supplied paths alone',
      problems: ['exact Git diff unavailable for --changed-files input'],
    };
  }
  // Version bumps are release mutations; inspect package.json content diff.
  const packageClaimedChanged = files.includes('package.json') || suppliedFiles.includes('package.json');
  if (packageClaimedChanged) {
    if (!changeSet.mergeBase) {
      problems.push('package.json is listed as changed but the exact package.json git diff is unavailable; --changed-files cannot bypass version inspection');
    } else {
      let basePackage;
      let headPackage;
      try {
        basePackage = JSON.parse(execFileSync('git', ['show', `${changeSet.mergeBase}:package.json`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        headPackage = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (error) {
        problems.push(`unable to parse package.json at the exact base/head refs: ${error.message}`);
        basePackage = null;
        headPackage = null;
      }
      if (!isObject(basePackage) || !isObject(headPackage)) {
        problems.push('package.json must be a JSON object at both exact base and HEAD refs');
      } else {
        if (typeof basePackage.version !== 'string' || typeof headPackage.version !== 'string') {
          problems.push('package.json version must be a string at both exact base and HEAD refs');
        } else if (basePackage.version !== headPackage.version) {
          problems.push(`change set mutates package.json "version" (${basePackage.version} -> ${headPackage.version}) (release mutation)`);
        }
      }
    }
  }
  if (changeSet.inputError) {
    return { id, status: 'fail', details: `${problems.length} release/security parity violation(s)`, problems };
  }
  return problems.length === 0
    ? { id, status: 'pass', details: `no release/tag/publish mutation across ${files.length} changed file(s)`, problems }
    : { id, status: 'fail', details: `${problems.length} release/security parity violation(s)`, problems };
}

function checkChildTerminality(receiptsDir, ciCheck) {
  const id = 'childTerminality';
  const { receipts, problems: receiptProblems, missing } = readReceipts(receiptsDir);
  const problems = [...receiptProblems];
  const terminal = new Set();
  const seenIssues = new Set();
  if (!missing) {
    for (const r of receipts) {
      if (r.kind !== 'child-terminal') continue;
      if (seenIssues.has(r.issue)) problems.push(`duplicate terminal receipt for child issue #${r.issue}`);
      seenIssues.add(r.issue);
      if (r.valid && ['merged', 'closed'].includes(r.state) && ciCheck?.authenticated === true) terminal.add(r.issue);
    }
  }
  const pendingIssues = [];
  for (const issue of EPIC_CONTRACT.childIssues) {
    if (!terminal.has(issue)) pendingIssues.push(issue);
  }
  const authenticated = ciCheck?.authenticated === true;
  const evidence = ciCheck?.evidence;
  const loadedCi = authenticated ? { evidence, prs: evidence?.pullRequests ?? evidence?.payload?.pullRequests } : { error: ciCheck?.details ?? 'CI evidence is not authenticated by live GitHub' };
  const ciByNumber = new Map();
  const directIssueByNumber = new Map();
  if (authenticated && Array.isArray(loadedCi.prs)) {
    for (const pr of loadedCi.prs) {
      if (isObject(pr) && Number.isSafeInteger(pr.number) && !ciByNumber.has(pr.number)) ciByNumber.set(pr.number, pr);
    }
  }
  const directIssues = authenticated ? (loadedCi.evidence?.directIssues ?? loadedCi.evidence?.payload?.directIssues) : [];
  if (authenticated && Array.isArray(directIssues)) {
    for (const direct of directIssues) {
      if (isObject(direct) && Number.isSafeInteger(direct.issue) && !directIssueByNumber.has(direct.issue)) {
        directIssueByNumber.set(direct.issue, direct);
      }
    }
  }
  const ciRequiredReceipts = receipts.filter((receipt) => (
    receipt.kind === 'child-terminal'
      && receipt.valid
      && ['merged', 'closed'].includes(receipt.state)
      && expectedPullRequest(receipt.issue) !== null
      && expectedPullRequest(receipt.issue) !== undefined
  ));
  const directRequiredReceipts = receipts.filter((receipt) => (
    receipt.kind === 'child-terminal'
      && receipt.valid
      && ['merged', 'closed'].includes(receipt.state)
      && expectedPullRequest(receipt.issue) === null
  ));
  if (authenticated) {
    for (const receipt of receipts) {
      if (receipt.kind !== 'child-terminal' || !receipt.valid || !['merged', 'closed'].includes(receipt.state)) continue;
      const expectedPr = expectedPullRequest(receipt.issue);
      if (expectedPr === null) {
        const evidence = receipt.childEvidence ?? {};
        const direct = directIssueByNumber.get(receipt.issue);
        if (!direct) {
          problems.push(`child issue #${receipt.issue} terminal receipt requires independently collected direct issue/commit/status evidence`);
          continue;
        }
        if (evidence.issueNumber !== direct.issue || evidence.issueState !== direct.state) {
          problems.push(`child issue #${receipt.issue} terminal receipt issue evidence does not match the independently collected direct issue artifact`);
        }
        if (evidence.commitSha !== direct.commit?.sha) {
          problems.push(`child issue #${receipt.issue} terminal receipt commit does not match the independently collected direct issue artifact`);
        }
        if (evidence.statusSha !== direct.status?.sha || evidence.statusState !== direct.status?.state) {
          problems.push(`child issue #${receipt.issue} terminal receipt status does not match the independently collected direct issue artifact`);
        }
        continue;
      }
      if (expectedPr === undefined) continue;
      const evidence = receipt.childEvidence ?? {};
      const ciPr = ciByNumber.get(expectedPr);
      if (!ciPr) {
        problems.push(`child issue #${receipt.issue} terminal receipt references expected PR #${expectedPr}, which is missing from CI evidence`);
        continue;
      }
      if (evidence.pullRequest !== expectedPr) {
        problems.push(`child issue #${receipt.issue} terminal receipt PR #${evidence.pullRequest ?? 'missing'} does not match expected PR #${expectedPr}`);
      }
      if (evidence.headSha !== ciPr.headSha) {
        problems.push(`child issue #${receipt.issue} terminal receipt head ${evidence.headSha ?? 'missing'} does not match CI evidence head ${ciPr.headSha ?? 'missing'} for PR #${expectedPr}`);
      }
      if (evidence.commitSha !== ciPr.mergeCommitSha) {
        problems.push(`child issue #${receipt.issue} terminal receipt commit ${evidence.commitSha ?? 'missing'} does not match CI evidence merge commit ${ciPr.mergeCommitSha} for PR #${expectedPr}`);
      }
      if (!Array.isArray(ciPr.checks) || ciPr.checks.length === 0) {
        problems.push(`CI evidence for expected PR #${expectedPr} has no structured status checks for child issue #${receipt.issue}`);
      }
    }
  } else if (ciCheck?.status === 'fail' && (ciRequiredReceipts.length > 0 || directRequiredReceipts.length > 0)) {
    problems.push(`child terminal receipts require independently verifiable CI evidence: ${loadedCi.error}`);
  }
  const gatesOpen = EPIC_CONTRACT.gateChildren.filter((issue) => !terminal.has(issue));
  const details = pendingIssues.length === 0
    ? 'all child issues have terminal evidence'
    : `awaiting terminal evidence for child issue(s): ${pendingIssues.join(', ')}`;
  return {
    id,
    status: problems.length > 0 ? 'fail' : pendingIssues.length === 0 && authenticated ? 'pass' : 'pending',
    details: gatesOpen.length > 0 ? `${details}; gate children still open: ${gatesOpen.join(', ')}` : details,
    problems,
    terminal: [...terminal],
  };
}

function checkRemainingRisk(root) {
  const id = 'remainingRisk';
  const registerPath = join(root, EPIC_CONTRACT.remainingRiskRegister);
  if (!existsSync(registerPath)) {
    return { id, status: 'fail', details: `remaining-risk register missing: ${EPIC_CONTRACT.remainingRiskRegister}`, problems: ['missing register'] };
  }
  let register;
  try {
    register = JSON.parse(readFileSync(registerPath, 'utf8'));
  } catch (error) {
    return { id, status: 'fail', details: `remaining-risk register is not valid JSON: ${error.message}`, problems: ['invalid JSON'] };
  }
  const problems = [];
  if (register.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (!Array.isArray(register.risks) || register.risks.length === 0) {
    problems.push('risks must be a non-empty array (explicit remaining-risk evidence is required, even if every entry is monitored)');
  }
  for (const [index, risk] of (Array.isArray(register.risks) ? register.risks : []).entries()) {
    const label = `risks[${index}]`;
    if (!isObject(risk)) { problems.push(`${label} must be an object`); continue; }
    for (const field of ['id', 'description', 'severity', 'mitigation', 'status']) {
      try { requiredString(risk[field], `${label}.${field}`); } catch (error) { problems.push(error.message); }
    }
    if (typeof risk.severity === 'string' && !['low', 'medium', 'high', 'critical'].includes(risk.severity)) {
      problems.push(`${label}.severity must be low|medium|high|critical`);
    }
    if (typeof risk.status === 'string' && !['open', 'monitored', 'mitigated', 'accepted'].includes(risk.status)) {
      problems.push(`${label}.status must be open|monitored|mitigated|accepted`);
    }
  }
  return problems.length === 0
    ? { id, status: 'pass', details: `${register.risks.length} remaining risk(s) explicitly registered`, problems }
    : { id, status: 'fail', details: `${problems.length} register problem(s)`, problems };
}

// --- Driver ----------------------------------------------------------------

export function runVerification(args) {
  const root = args.root;
  const receiptsDir = args.receiptsDir ?? join(root, EPIC_CONTRACT.receiptsDir);
  const measured = measureSurface(root);

  if (args.emitMetricsReceipt) {
    const receipt = {
      schemaVersion: 1,
      kind: 'metrics-snapshot',
      issue: EPIC_CONTRACT.closureIssue,
      createdAt: new Date().toISOString(),
      payload: { ...measured.counts, measurementSha256: measured.measurementSha256, base: args.base },
    };
    writeFileSync(args.emitMetricsReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  }

  const ciCheck = checkExactHeadCi(root, args.evidence);
  const childCheck = checkChildTerminality(receiptsDir, ciCheck);
  const terminalChildren = new Set(childCheck.terminal ?? []);
  const requiredDocPaths = [
    EPIC_CONTRACT.planningDoc,
    'docs/design/ISSUE-3712-RELEASE-VERIFICATION.md',
    'receipts/epic-3698/README.md',
  ];
  const docPaths = [...new Set([...requiredDocPaths, ...(args.docPaths ?? [])])];

  const checks = [
    ciCheck,
    checkDocsLinks(root, docPaths),
    checkShippedMetrics(measured, terminalChildren),
    checkMigrationReceipts(receiptsDir),
    checkRetirementPolicy(receiptsDir),
    checkReleaseSecurityParity(root, args.base, args.changedFiles, ciCheck.live?.expectedBase ?? null),
    childCheck,
    checkRemainingRisk(root),
  ];

  const failed = checks.filter((c) => c.status === 'fail');
  const pending = checks.filter((c) => c.status === 'pending');
  const verdict = failed.length > 0 ? 'FAIL' : pending.length > 0 ? 'PENDING_TEMPORAL' : 'PASS';
  return {
    schemaVersion: 1,
    kind: 'epic-3698-closure-verdict',
    epic: EPIC_CONTRACT.epic,
    issue: EPIC_CONTRACT.closureIssue,
    generatedAt: new Date().toISOString(),
    verdict,
    exitCode: verdict === 'PASS' ? 0 : verdict === 'PENDING_TEMPORAL' ? 2 : 1,
    checks,
    temporalConditions: pending.map((c) => ({ check: c.id, details: c.details })),
    note: 'No release/tag/publish mutation is performed or authorized by this verifier. Pending temporal conditions record why epic #3698 must remain open; they are not failures of the mechanism.',
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = runVerification(args);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.jsonOut) writeFileSync(args.jsonOut, json);
  process.stdout.write(json);
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'PENDING';
    process.stderr.write(`[${mark}] ${check.id}: ${check.details}\n`);
    for (const problem of check.problems) process.stderr.write(`  - ${problem}\n`);
  }
  process.stderr.write(`verdict: ${report.verdict}\n`);
  return report.exitCode;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`verify-epic-3698-closure: ${error.message}\n`);
    process.exitCode = 1;
  }
}
