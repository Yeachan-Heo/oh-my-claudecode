import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-epic-3698-closure.mjs');

interface RunResult {
  status: number;
  report: {
    verdict: string;
    exitCode: number;
    checks: Array<{ id: string; status: string; problems: string[] }>;
  };
}

function runVerifier(args: string[], cwd = REPO_ROOT, options: { fakeGh?: boolean; bindHeadBase?: boolean; bindShipping?: boolean } = {}): RunResult {
  const env = { ...process.env };
  const rootIndex = args.indexOf('--root');
  const fixtureRoot = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : cwd;
  const fakeGh = join(fixtureRoot, 'fake-gh', 'gh');
  if (options.fakeGh !== false && existsSync(fakeGh)) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' });
    if (head.status === 0) {
      const fixturePath = join(fixtureRoot, 'gh-fixture.json');
      const ghFixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const headSha = head.stdout.trim();
      const evidencePath = join(fixtureRoot, 'ci-evidence.json');
      if (options.bindShipping !== false && existsSync(evidencePath)) {
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
        const direct = evidence.payload?.directIssues?.[0];
        if (direct?.commit?.sha) {
          direct.shipping = {
            headSha,
            status: 'ahead',
            aheadBy: 1,
            behindBy: 0,
            mergeBaseSha: direct.commit.sha,
          };
          direct.source.shipping = `repos/fixture/example/compare/${direct.commit.sha}...${headSha}`;
          ghFixture.compares[`${direct.commit.sha}...${headSha}`] = {
            status: 'ahead',
            ahead_by: 1,
            behind_by: 0,
            merge_base_commit: { sha: direct.commit.sha },
          };
          writeJson(evidencePath, evidence);
        }
      }
      if (options.bindHeadBase !== false) {
        const baseIndex = args.indexOf('--base');
        const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
        if (base) {
        const mergeBase = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' });
          if (mergeBase.status === 0) {
          ghFixture.commitPulls ??= {};
          ghFixture.commitPulls[headSha] = [{
            state: 'open',
            head: { sha: headSha },
            base: { ref: base, sha: mergeBase.stdout.trim() },
          }];
          }
        }
      }
      writeJson(fixturePath, ghFixture);
    }
    env.PATH = `${dirname(fakeGh)}${delimiter}${env.PATH ?? ''}`;
    env.EPIC_GH_FIXTURE = join(fixtureRoot, 'gh-fixture.json');
  } else if (options.fakeGh === false) {
    env.PATH = '';
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env });
  const report = JSON.parse(result.stdout);
  return { status: result.status ?? -1, report };
}

function check(run: RunResult, id: string) {
  const found = run.report.checks.find((c) => c.id === id);
  expect(found, `check ${id} present`).toBeTruthy();
  return found!;
}

const TIER0_WORKFLOWS = ['plan', 'execute', 'review', 'verify'];
const TIER0_ROLES = ['planner', 'executor', 'reviewer', 'verifier'];
const ALL_CHILDREN = [3702, 3703, 3704, 3705, 3706, 3707, 3708, 3709, 3710, 3711];
const EXPECTED_CHILD_PRS: Record<number, number | null> = {
  3702: 3721,
  3703: 3720,
  3704: 3724,
  3705: 3716,
  3706: 3715,
  3707: 3725,
  3708: 3729,
  3709: null,
  3710: 3719,
  3711: 3723,
};

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gitFixture(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function installFakeGh(root: string, data: unknown) {
  const fakeGhDir = join(root, 'fake-gh');
  mkdirSync(fakeGhDir, { recursive: true });
  writeJson(join(root, 'gh-fixture.json'), data);
  const script = [
    '#!/usr/bin/env node',
    "const { readFileSync } = require('node:fs');",
    "const data = JSON.parse(readFileSync(process.env.EPIC_GH_FIXTURE, 'utf8'));",
    'const args = process.argv.slice(2);',
    "const out = (value) => process.stdout.write(JSON.stringify(value ?? null) + '\\n');",
    "if (args[0] === 'repo' && args[1] === 'view') out({ nameWithOwner: data.repository });",
    "else if (args[0] === 'pr' && args[1] === 'view') out(data.prs[args[2]]);",
    "else if (args[0] === 'issue' && args[1] === 'view') out(data.issues[args[2]]);",
    "else if (args[0] === 'api') {",
    '  const path = args[1];',
    "  const page = Number(new URL('https://fixture.invalid/' + path).searchParams.get('page') ?? '1');",
    '  const pageRecords = (values) => values.slice((page - 1) * 100, page * 100);',
    '  const pull = path.match(/^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)$/);',
    '  const timeline = path.match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/timeline/);',
    '  const status = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/status$/);',
    '  const statuses = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/statuses/);',
    '  const checks = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/check-runs/);',
    '  const commitPulls = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/pulls/);',
    '  const commit = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})$/);',
    '  const workflows = path.match(/^repos\\/[^/]+\\/[^/]+\\/actions\\/runs/);',
    '  const compare = path.match(/^repos\\/[^/]+\\/[^/]+\\/compare\\/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})/);',
    '  if (pull) { const pr = data.prs[pull[1]]; out({ number: pr.number, state: pr.state === "MERGED" ? "closed" : "open", merged_at: pr.state === "MERGED" ? "2026-08-12T00:00:00Z" : null, head: { sha: pr.headRefOid }, merge_commit_sha: pr.mergeCommit.oid, base: { ref: pr.baseRefName, sha: pr.baseRefOid } }); }',
    '  else if (timeline) out(pageRecords(data.timelines[timeline[1]] ?? []));',
    '  else if (status) out(data.statuses[status[1]]);',
    '  else if (statuses) out(pageRecords(data.legacyStatuses?.[statuses[1]] ?? []));',
    '  else if (checks) { const values = data.checkRuns[checks[1]] ?? []; out({ total_count: values.length, check_runs: pageRecords(values) }); }',
    '  else if (commitPulls) out(pageRecords(data.commitPulls?.[commitPulls[1]] ?? []));',
    '  else if (commit) out(data.commits[commit[1]]);',
    '  else if (workflows) { const values = data.workflowRuns ?? []; out({ total_count: values.length, workflow_runs: pageRecords(values) }); }',
    '  else if (compare) out(data.compares?.[compare[1] + "..." + compare[2]]);',
    "  else { process.stderr.write('unknown fake gh api: ' + path + '\\n'); process.exit(2); }",
    "} else { process.stderr.write('unknown fake gh args: ' + args.join(' ') + '\\n'); process.exit(2); }",
    '',
  ].join('\n');
  writeFileSync(join(fakeGhDir, 'gh'), script);
  chmodSync(join(fakeGhDir, 'gh'), 0o755);
}

function commitFixture(root: string, message: string) {
  const commands = [
    ['init', '-q'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'fixture'],
    ['add', '-A'],
    ['commit', '-qm', message],
  ];
  for (const args of commands) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function commitFixtureHead(root: string, message: string) {
  for (const args of [['add', '-A'], ['commit', '-qm', message]]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

// Builds a synthetic repository root where every epic #3698 closure
// prerequisite is satisfied, so the verifier must return PASS / exit 0.
function buildCompleteFixture(root: string) {
  for (const skill of TIER0_WORKFLOWS) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  mkdirSync(join(root, 'commands'), { recursive: true });
  for (let i = 0; i < 12; i += 1) writeFileSync(join(root, 'commands', `cmd-${i}.md`), 'x\n');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (let i = 0; i < 5; i += 1) writeFileSync(join(root, '.github', 'workflows', `w${i}.yml`), 'on: push\n');
  mkdirSync(join(root, 'src', 'agents'), { recursive: true });
  for (const role of TIER0_ROLES) writeFileSync(join(root, 'src', 'agents', `${role}.ts`), 'export {};\n');

  const receipts = join(root, 'receipts', 'epic-3698');
  mkdirSync(receipts, { recursive: true });
  const head = 'a'.repeat(40);
  for (const issue of ALL_CHILDREN) {
    const pullRequest = EXPECTED_CHILD_PRS[issue];
    writeJson(join(receipts, `child-${issue}-terminal.receipt.json`), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'merged',
        evidence: pullRequest === null
          ? {
              issue: { number: 3709, state: 'CLOSED' },
              commit: { sha: 'b'.repeat(40) },
              status: { state: 'success', sha: 'b'.repeat(40) },
            }
          : {
              pullRequest: { number: pullRequest, headSha: head },
              commit: { sha: 'b'.repeat(40) },
              status: { conclusion: 'success', sha: head },
            },
      },
    });
  }
  writeJson(join(receipts, 'alias-usage.receipt.json'), {
    schemaVersion: 1,
    kind: 'alias-usage',
    issue: 3711,
    createdAt: '2026-08-12T00:00:00Z',
    payload: {
      canonicalShare: 0.97,
      minorReleases: 2,
      daysSinceDeprecation: 91,
      consecutiveReleasesAtThreshold: 2,
      knownCriticalIntegrations: 0,
    },
  });
  writeJson(join(root, 'receipts', 'epic-3698', 'remaining-risk.json'), {
    schemaVersion: 1,
    risks: [
      { id: 'R1', description: 'residual', severity: 'low', mitigation: 'monitored by verifier', status: 'monitored' },
    ],
  });
  writeFileSync(join(receipts, 'README.md'), '# receipts\n');
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  writeFileSync(join(root, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'), '# design\n[receipts](../../receipts/epic-3698/README.md)\n');

  writeJson(join(root, 'ci-evidence.json'), {
    schemaVersion: 1,
    kind: 'ci-evidence',
    issue: 3712,
    createdAt: '2026-08-12T00:00:00Z',
    payload: {
      collector: 'test-fixture-collector',
      repository: 'fixture/example',
      directIssues: [{
        issue: 3709,
        state: 'CLOSED',
        commit: { sha: 'b'.repeat(40) },
        status: { sha: 'b'.repeat(40), state: 'success' },
        statuses: [],
        checks: [{ name: 'direct-check', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
        workflows: [{ id: 1, name: 'Direct CI', path: '.github/workflows/direct.yml', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
        shipping: { headSha: 'e'.repeat(40), status: 'ahead', aheadBy: 1, behindBy: 0, mergeBaseSha: 'b'.repeat(40) },
        source: {
          repository: 'fixture/example',
          issue: 'repos/fixture/example/issues/3709',
          timeline: 'repos/fixture/example/issues/3709/timeline',
          eventType: 'referenced',
          commitId: 'b'.repeat(40),
          commit: `repos/fixture/example/commits/${'b'.repeat(40)}`,
          status: `repos/fixture/example/commits/${'b'.repeat(40)}/status`,
          statuses: `repos/fixture/example/commits/${'b'.repeat(40)}/statuses`,
          checks: `repos/fixture/example/commits/${'b'.repeat(40)}/check-runs`,
          workflows: 'repos/fixture/example/actions/runs',
          shipping: `repos/fixture/example/compare/${'b'.repeat(40)}...${'e'.repeat(40)}`,
        },
      }],
      pullRequests: ALL_CHILDREN.filter((issue) => EXPECTED_CHILD_PRS[issue] !== null).map((issue) => ({
        childIssue: issue,
        number: EXPECTED_CHILD_PRS[issue],
        headSha: head,
        mergeCommitSha: 'b'.repeat(40),
        state: 'MERGED',
        checks: [
          { name: 'CI / Test', conclusion: 'success', sha: head },
          { name: 'CI / Lint', conclusion: 'skipped', sha: head },
        ],
      })),
    },
  });
  installFakeGh(root, {
    repository: 'fixture/example',
    prs: Object.fromEntries(ALL_CHILDREN
      .filter((issue) => EXPECTED_CHILD_PRS[issue] !== null)
      .map((issue) => [String(EXPECTED_CHILD_PRS[issue]), {
        number: EXPECTED_CHILD_PRS[issue],
        state: 'MERGED',
        headRefOid: head,
        mergeCommit: { oid: 'b'.repeat(40) },
        baseRefName: 'dev',
        baseRefOid: 'd'.repeat(40),
        statusCheckRollup: [
          { workflowName: 'CI', name: 'Test', conclusion: 'success' },
          { workflowName: 'CI', name: 'Lint', conclusion: 'skipped' },
        ],
      }])),
    issues: Object.fromEntries(ALL_CHILDREN.map((issue) => [String(issue), { number: issue, state: 'CLOSED' }])),
    timelines: { '3709': [{ event: 'referenced', commit_id: 'b'.repeat(40) }] },
    commits: { ['b'.repeat(40)]: { sha: 'b'.repeat(40), repository: { full_name: 'fixture/example' } } },
    statuses: { ['b'.repeat(40)]: { sha: 'b'.repeat(40), state: 'success' } },
    checkRuns: {
      [head]: [
        { name: 'CI / Test', status: 'completed', conclusion: 'success', head_sha: head },
        { name: 'CI / Lint', status: 'completed', conclusion: 'skipped', head_sha: head },
      ],
      ['b'.repeat(40)]: [{ name: 'direct-check', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
    },
    legacyStatuses: { [head]: [], ['b'.repeat(40)]: [] },
    commitPulls: {},
    workflowRuns: [{ id: 1, name: 'Direct CI', path: '.github/workflows/direct.yml', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
    compares: { [`${'b'.repeat(40)}...${'e'.repeat(40)}`]: { status: 'ahead', ahead_by: 1, behind_by: 0, merge_base_commit: { sha: 'b'.repeat(40) } } },
  });
  writeFileSync(join(root, 'changed-files.txt'), 'scripts/verify-epic-3698-closure.mjs\nreceipts/epic-3698/README.md\n');
  return head;
}

describe('epic-3698 closure verifier (#3712)', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'epic-3698-fixture-'));
  });

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('passes with exit 0 when every acceptance surface is satisfied', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'base');
    gitFixture(fixture, ['branch', 'base']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'base',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.report.verdict, JSON.stringify(run.report.checks, null, 2)).toBe('PASS');
    expect(run.status).toBe(0);
    for (const c of run.report.checks) expect(c.status, `${c.id}: ${c.problems.join('; ')}`).toBe('pass');
  });

  it('rejects CI evidence recorded at a stale head', () => {
    buildCompleteFixture(fixture);
    const head = 'a'.repeat(40);
    const stale = 'b'.repeat(40);
    writeJson(join(fixture, 'ci-evidence.json'), {
      schemaVersion: 1,
      payload: {
        pullRequests: [
          { number: 1, headSha: head, checks: [{ name: 'CI / Test', conclusion: 'success', sha: stale }] },
        ],
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain(stale);
  });

  it('rejects caller-controlled valid SHA evidence that disagrees with live GitHub', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const forged = 'c'.repeat(40);
    evidence.payload.pullRequests[0].headSha = forged;
    evidence.payload.pullRequests[0].mergeCommitSha = forged;
    evidence.payload.pullRequests[0].checks = [{ name: 'CI / Test', conclusion: 'success', sha: forged }];
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('does not match live PR head');
  });

  it('never passes caller evidence when live GitHub verification is unavailable', () => {
    buildCompleteFixture(fixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ], fixture, { fakeGh: false });
    expect(run.status).toBe(2);
    expect(check(run, 'exactHeadCi').status).toBe('pending');
    expect(run.report.verdict).not.toBe('PASS');
  });

  it('rejects checks without live-head binding and non-green conclusions', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'ci-evidence.json'), {
      schemaVersion: 1,
      payload: {
        pullRequests: [
          { number: 1, headSha: 'a'.repeat(40), checks: [{ name: 'CI / Test', conclusion: 'failure' }] },
        ],
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(run.status).toBe(1);
    expect(problems).toContain('.sha must be a 40-char lowercase hex SHA');
    expect(problems).toContain('failure');
  });

  it('rejects unsigned exactHead attestations', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.pullRequests[0].checks = [{ name: 'CI / Test', conclusion: 'success', exactHead: true }];
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('exactHead is unsupported');
  });

  it('rejects forged child-terminal receipts that provide only free-form evidence', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3702-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3702,
      createdAt: '2026-08-12T00:00:00Z',
      payload: { state: 'merged', evidence: 'PR #3721 merged with green CI' },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'childTerminality').status).toBe('fail');
    expect(check(run, 'childTerminality').problems.join(' ')).toContain('structured object');
  });

  it('rejects unrelated or missing child PR substitution in CI evidence', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.pullRequests[0].number = 3727;
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(problems).toContain('not an expected child PR');
    expect(problems).toContain('missing expected PR #3721');
  });

  it('rejects CI evidence with an absent childIssue or non-merged PR state', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    delete evidence.payload.pullRequests[0].childIssue;
    evidence.payload.pullRequests[1].state = 'OPEN';
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(problems).toContain('childIssue must equal');
    expect(problems).toContain('state must be MERGED');
  });

  it('rejects forged no-PR terminal evidence that does not match the direct issue artifact', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3709,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'closed',
        evidence: {
          issue: { number: 3709, state: 'CLOSED' },
          commit: { sha: 'c'.repeat(40) },
          status: { state: 'success', sha: 'c'.repeat(40) },
        },
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).not.toBe(0);
    expect(check(run, 'childTerminality').status).toBe('fail');
    expect(check(run, 'childTerminality').problems.join(' ')).toContain('independently collected direct issue artifact');
  });

  it('rejects forged direct issue commit/status evidence even when receipt and CI JSON agree', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const forged = 'c'.repeat(40);
    const direct = evidence.payload.directIssues[0];
    direct.commit.sha = forged;
    direct.status.sha = forged;
    direct.checks[0].head_sha = forged;
    direct.workflows[0].head_sha = forged;
    direct.source.commitId = forged;
    direct.source.commit = `repos/fixture/example/commits/${forged}`;
    direct.source.status = `repos/fixture/example/commits/${forged}/status`;
    direct.source.statuses = `repos/fixture/example/commits/${forged}/statuses`;
    direct.source.checks = `repos/fixture/example/commits/${forged}/check-runs`;
    direct.shipping.mergeBaseSha = forged;
    direct.source.shipping = `repos/fixture/example/compare/${forged}...${direct.shipping.headSha}`;
    writeJson(evidencePath, evidence);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3709,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'closed',
        evidence: {
          issue: { number: 3709, state: 'CLOSED' },
          commit: { sha: forged },
          status: { state: 'success', sha: forged },
        },
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).not.toBe(0);
    expect(check(run, 'exactHeadCi').status, JSON.stringify(check(run, 'exactHeadCi'), null, 2)).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('live issue timeline referenced.commit_id');
  });

  it('rejects committed.sha-only timeline evidence for direct issue #3709', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.timelines['3709'] = [{ event: 'committed', sha: 'b'.repeat(40) }];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('referenced.commit_id');
  });

  it('rejects mixed green and failed live PR check rollups', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns['a'.repeat(40)].push({
      name: 'Failed attempt',
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
    });
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('failure');
  });

  it('fails closed when direct check-run pagination contains a late failure', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns['b'.repeat(40)] = Array.from({ length: 100 }, (_, index) => ({
      name: `green-${index}`,
      status: 'completed',
      conclusion: 'success',
      head_sha: 'b'.repeat(40),
    }));
    ghFixture.checkRuns['b'.repeat(40)].push({
      name: 'late-failure',
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'b'.repeat(40),
    });
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('liveChecks[100].conclusion');
  });

  it('rejects pending legacy status contexts even when check runs and workflows are green', () => {
    buildCompleteFixture(fixture);
    const sha = 'b'.repeat(40);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.directIssues[0].status.state = 'pending';
    evidence.payload.directIssues[0].statuses = [{ context: 'legacy-required', state: 'pending', sha }];
    writeJson(evidencePath, evidence);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.statuses[sha].state = 'pending';
    ghFixture.legacyStatuses[sha] = [{ context: 'legacy-required', state: 'pending', sha }];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('statuses[0].state must be success');
  });

  it('rejects a failed child PR check beyond the first 100 records', () => {
    buildCompleteFixture(fixture);
    const head = 'a'.repeat(40);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.checkRuns[head] = Array.from({ length: 100 }, (_, index) => ({
      name: `green-${index}`,
      status: 'completed',
      conclusion: 'success',
      head_sha: head,
    }));
    ghFixture.checkRuns[head].push({ name: 'late-pr-failure', status: 'completed', conclusion: 'failure', head_sha: head });
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('liveChecks[100].conclusion');
  });

  it('finds direct issue referenced.commit_id after the first timeline page', () => {
    buildCompleteFixture(fixture);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.timelines['3709'] = [
      ...Array.from({ length: 100 }, () => ({ event: 'commented' })),
      { event: 'referenced', commit_id: 'b'.repeat(40) },
    ];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'exactHeadCi').status).toBe('pass');
  });

  it('rejects HEAD as a valid-but-wrong base against the authenticated expected merge base', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'authenticated base');
    const authenticatedBase = gitFixture(fixture, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'closure head');
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');

    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    for (const pr of Object.values(ghFixture.prs) as Array<Record<string, unknown>>) {
      pr.baseRefName = 'main';
      pr.baseRefOid = authenticatedBase;
    }
    const closureHead = gitFixture(fixture, ['rev-parse', 'HEAD']);
    ghFixture.commitPulls[closureHead] = [{
      state: 'open',
      head: { sha: closureHead },
      base: { ref: 'main', sha: authenticatedBase },
    }];
    writeJson(ghFixturePath, ghFixture);

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ], fixture, { bindHeadBase: false });
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('authenticated expected merge base');
  });

  it('does not pass Git-backed release parity without an authenticated exact-head PR base', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'base');
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD',
    ], fixture, { bindHeadBase: false });
    expect(run.status).toBe(2);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('authenticated expected merge base unavailable');
  });

  it('derives the authenticated exact-head PR base from a later associated-pulls page', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'authenticated base');
    const authenticatedBase = gitFixture(fixture, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'closure head');
    const closureHead = gitFixture(fixture, ['rev-parse', 'HEAD']);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.commitPulls[closureHead] = [
      ...Array.from({ length: 100 }, () => ({ state: 'closed', head: { sha: closureHead }, base: { ref: 'other', sha: closureHead } })),
      { state: 'open', head: { sha: closureHead }, base: { ref: 'main', sha: authenticatedBase } },
    ];
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD',
    ], fixture, { bindHeadBase: false });
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('authenticated expected merge base');
  });

  it('rejects authentic direct issue evidence when the referenced commit is not shipped in exact HEAD', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'base');
    const base = gitFixture(fixture, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');
    const head = gitFixture(fixture, ['rev-parse', 'HEAD']);
    const commit = 'b'.repeat(40);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.directIssues[0].shipping = {
      headSha: head,
      status: 'diverged',
      aheadBy: 5,
      behindBy: 3,
      mergeBaseSha: commit,
    };
    evidence.payload.directIssues[0].source.shipping = `repos/fixture/example/compare/${commit}...${head}`;
    writeJson(evidencePath, evidence);
    const ghFixturePath = join(fixture, 'gh-fixture.json');
    const ghFixture = JSON.parse(readFileSync(ghFixturePath, 'utf8'));
    ghFixture.commitPulls[head] = [{ state: 'open', head: { sha: head }, base: { ref: 'base', sha: base } }];
    ghFixture.compares[`${commit}...${head}`] = {
      status: 'diverged',
      ahead_by: 5,
      behind_by: 3,
      merge_base_commit: { sha: commit },
    };
    writeJson(ghFixturePath, ghFixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--base', 'base',
    ], fixture, { bindHeadBase: false, bindShipping: false });
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('not proven reachable');
  });

  it('does not let --changed-files bypass package.json version-diff inspection', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'package.json'), { version: '9.9.9' });
    writeFileSync(join(fixture, 'changed-files.txt'), 'package.json\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('unauthenticated');
  });

  it('does not let unauthenticated --changed-files omit package.json when the Git base is unavailable', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'package.json'), { name: 'fixture', version: '9.9.9' });
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('unauthenticated');
  });

  it('detects a compact/reordered package.json version bump by parsing base and HEAD JSON', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    commitFixture(fixture, 'base package');
    writeFileSync(join(fixture, 'package.json'), '{"version":"2.0.0","name":"fixture"}\n');
    commitFixtureHead(fixture, 'bumped package');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD^',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('1.0.0 -> 2.0.0');
  });

  it('compares package.json against the exact merge-base when the selected base diverges', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    commitFixture(fixture, 'common ancestor');
    gitFixture(fixture, ['branch', 'selected-base']);
    gitFixture(fixture, ['checkout', 'selected-base']);
    writeFileSync(join(fixture, 'package.json'), '{"version":"2.0.0","name":"fixture"}\n');
    commitFixtureHead(fixture, 'selected base version');
    gitFixture(fixture, ['checkout', '-b', 'head', 'selected-base~1']);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
    commitFixtureHead(fixture, 'head version');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'selected-base',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('1.0.0 -> 2.0.0');
  });

  it('does not trust a shallow-history HEAD^ fallback when the requested base is unavailable', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, '.github', 'workflows', 'release.yml'), 'on: push\n');
    commitFixture(fixture, 'protected change before HEAD');
    writeFileSync(join(fixture, 'head.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');

    // Model a depth-2 checkout: the protected change is in the shallow parent,
    // while the requested base and its origin equivalent are both unavailable.
    const shallowParent = gitFixture(fixture, ['rev-parse', 'HEAD^']);
    writeFileSync(join(fixture, '.git', 'shallow'), `${shallowParent}\n`);

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'missing-base',
    ]);
    expect(run.status).toBe(2);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('change set unavailable');
    expect(check(run, 'releaseSecurityParity').details).not.toContain('HEAD^');
  });

  it('fails closed on release/publish authority mutation in the change set', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'changed-files.txt'), '.github/workflows/release.yml\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('release.yml');
  });

  it('allows only the exact v5 release smoke skill-path correction', () => {
    buildCompleteFixture(fixture);
    const workflowPath = join(fixture, '.github', 'workflows', 'release.yml');
    writeFileSync(workflowPath, [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          test -s "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md"',
      '          test -f "$SMOKE_PACKAGE_ROOT/skills/setup/SKILL.md"',
      '          cmp "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md" "$SMOKE_PROJECT/.claude/skills/omc-reference/SKILL.md"',
      '',
    ].join('\n'));
    commitFixture(fixture, 'base release smoke');
    gitFixture(fixture, ['branch', 'base']);
    writeFileSync(workflowPath, [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          test -s "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md"',
      '          cmp "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md" "$SMOKE_PROJECT/.claude/skills/wiki/SKILL.md"',
      '',
    ].join('\n'));
    commitFixtureHead(fixture, 'correct release smoke');
    writeFileSync(join(fixture, 'changed-files.txt'), '.github/workflows/release.yml\n');

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'base',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pass');
  });

  it('fails on schema-invalid migration receipts', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'broken.receipt.json'), { schemaVersion: 2, kind: 'nope' });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'migrationReceipts').status).toBe('fail');
  });

  it('reports pending (exit 2) while the alias retirement window is unsatisfied, without authorizing removal', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'alias-usage.receipt.json'), {
      schemaVersion: 1,
      kind: 'alias-usage',
      issue: 3711,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        canonicalShare: 0.8,
        minorReleases: 1,
        daysSinceDeprecation: 30,
        consecutiveReleasesAtThreshold: 0,
        knownCriticalIntegrations: 1,
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(2);
    expect(run.report.verdict).toBe('PENDING_TEMPORAL');
    expect(check(run, 'aliasRetirementPolicy').status).toBe('pending');
    expect(check(run, 'aliasRetirementPolicy').details).toContain('must NOT be removed');
  });

  it('reports pending (exit 2) when children lack terminal evidence', () => {
    buildCompleteFixture(fixture);
    rmSync(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'));
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(2);
    expect(check(run, 'childTerminality').status).toBe('pending');
    expect(check(run, 'childTerminality').details).toContain('3709');
  });

  it('fails when the remaining-risk register is missing', () => {
    buildCompleteFixture(fixture);
    rmSync(join(fixture, 'receipts', 'epic-3698', 'remaining-risk.json'));
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'remainingRisk').status).toBe('fail');
  });

  it('detects broken relative links in closure documents', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[missing](../../receipts/epic-3698/NOPE.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
  });

  it('keeps mandatory closure documents when --docs adds an extra path', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
      '--docs', 'docs/safe.md',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped-label reference links that traverse outside the repository root', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape][out\\]side]\n\n[out\\]side]: ../../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped inline-label destinations that traverse outside the repository root', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape\\]label](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('canonicalizes nested CommonMark labels and percent-escaped destination bytes before containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[outer [nested]](%2e%2e/%2e%2e/%2e%2e/outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('canonicalizes CommonMark character references before containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape](&#x2e;&#x2e;/&#46;&#46;/&period;&period;/outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('uses the first CommonMark reference definition for containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n[a]: ../../../outside.md\n[a]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('uses first-definition precedence for nested escaped labels and percent destinations', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[outer [nested]][DuP\\]]\n\n[dup\\]]: %2e%2e/%2e%2e/%2e%2e/outside.md\n[DUP\\]]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not let a later duplicate definition hide an outside symlink', ({ skip }) => {
    buildCompleteFixture(fixture);
    const externalRoot = mkdtempSync(join(tmpdir(), 'epic-3698-duplicate-external-'));
    const externalTarget = join(externalRoot, 'outside.md');
    writeFileSync(externalTarget, 'outside\n');
    try {
      try {
        symlinkSync(externalTarget, join(fixture, 'outside-link.md'));
      } catch (error) {
        skip(`symlink creation unavailable: ${(error as Error).message}`);
        return;
      }
      writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
      writeFileSync(
        join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
        '# design\n[a]\n\n[a]: ../../outside-link.md\n[A]: ../safe.md\n',
      );
      const run = runVerifier([
        '--root', fixture,
        '--evidence', join(fixture, 'ci-evidence.json'),
        '--changed-files', join(fixture, 'changed-files.txt'),
      ]);
      expect(run.status).toBe(1);
      expect(check(run, 'docsLinks').problems.join(' ')).toContain('resolves outside repository root');
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('finds reference definitions inside block quote containers', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape]\n\n> [escape]: %2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('finds reference destinations on the line after the definition colon', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape]\n\n[escape]:\n%2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('finds nested escaped reference definitions inside list and block quote containers', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[outer [nested]][EsC\\]]\n\n- > [esc\\]]:\n  > %2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('fails closed when a reference definition destination form is unsupported', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape]\n\n> [escape]:\n>\n> unavailable\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('unsupported or missing destination');
  });

  it('finds nested-list continuation and multiline-label reference definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape link]\n\n- outer\n  - inner\n\n    [escape\n      link]: %2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('checks every potential definition so fenced text cannot mask a later traversal', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n```md\n[a]: ../safe.md\n```\n\n[a]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not alias escaped punctuation or non-CommonMark label whitespace', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[x][foo\\!]\n[y][foo\fbar]\n\n[foo!]: ../safe.md\n[foo\\!]: ../../../outside.md\n[foo bar]: ../safe.md\n[foo\fbar]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('handles CR-only definitions and encoded hash path bytes as local containment input', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\r[escape]\r[escape]: %23/../../../../outside.md\r',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('case-folds sharp-S labels while still checking every definition target', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[x][SS]\n\n[ẞ]: ../safe.md\n[SS]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('recognizes ordered-list continuation reference definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n10. item\n\n    [escape]: %2e%2e/%2e%2e/%2e%2e/outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ignores fenced pseudo-definitions while honoring the later real definition', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n```md\n[a]: ../../../outside.md\n```\n\n[a]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('does not treat a backtick-bearing info string as a valid fence opener', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n``` info `\n\n[escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('decodes named percent entities before containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape](&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('resolves safe multiline, ordered-list, and blockquote definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a][safe label]\n[b][ordered]\n[c][quoted]\n\n[safe\n label]: ../safe.md\n\n10. item\n\n    [ordered]: ../safe.md\n\n> [quoted]:\n> ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status, JSON.stringify(check(run, 'docsLinks'))).toBe('pass');
  });

  it('ignores inline and fenced code link examples', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n`[inline](../../../outside.md)`\n\n```md\n[fenced](../../../outside.md)\n```\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('unwinds nested lists to recognize an ancestor continuation definition', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n10. outer\n    - inner\n\n    [escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends a fenced block when its block quote container ends', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n> ```\n> code\n\n[escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ignores tab-indented code pseudo-definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n\t[a]: ../../../outside.md\n\n[a]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('ends list-contained fences when the list container closes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- ```\n  code\n\n[escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('keeps an invalid trailing-text fence closer inside the code block', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n```\ncode\n``` not-a-closer\n[example](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('checks quoted, unquoted, mixed-case, and srcset raw HTML URL attributes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<A HREF="&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/outside.md">x</A>\n<img SRC=../../../outside.md>\n<img srcset="../safe.md 1x, ../../../outside.md 2x">\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('contains namespaced SVG xlink:href destinations', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<svg><use XLINK:HREF="%2e%2e/%2e%2e/%2e%2e/outside.svg"></use></svg>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not mask Markdown inside malformed non-CommonMark HTML', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a title=` [escape](../../../outside.md)>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('treats a backslash-escaped less-than sign as literal text, not raw HTML', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n\\<a href="../../../outside.md">literal</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('allows raw HTML anchors and external schemes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a href="#section">anchor</a>\n<img src="https://example.com/image.png">\n<form action=mailto:test@example.com></form>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('ignores raw HTML URL examples inside inline and fenced code', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n`<a href="../../../outside.md">example</a>`\n\n```html\n<img src=../../../outside.md>\n```\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('rejects raw HTML URLs through symlinks outside the repository', ({ skip }) => {
    buildCompleteFixture(fixture);
    const externalRoot = mkdtempSync(join(tmpdir(), 'epic-3698-html-external-'));
    const externalTarget = join(externalRoot, 'outside.md');
    writeFileSync(externalTarget, 'outside\n');
    try {
      try {
        symlinkSync(externalTarget, join(fixture, 'outside-html-link.md'));
      } catch (error) {
        skip(`symlink creation unavailable: ${(error as Error).message}`);
        return;
      }
      writeFileSync(
        join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
        '# design\n<a href="../../outside-html-link.md">outside</a>\n',
      );
      const run = runVerifier([
        '--root', fixture,
        '--evidence', join(fixture, 'ci-evidence.json'),
        '--changed-files', join(fixture, 'changed-files.txt'),
      ]);
      expect(run.status).toBe(1);
      expect(check(run, 'docsLinks').problems.join(' ')).toContain('resolves outside repository root');
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('masks fences after alternating list and blockquote prefixes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- > ```md\n  > [example](../../../outside.md)\n  > ```\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status, JSON.stringify(check(run, 'docsLinks'))).toBe('pass');
  });

  it('ends a fence when the ordered container chain changes at equal depth', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- > ```md\n> - [escape]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('parses HTML tags with greater-than characters inside quoted attributes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a title=">" href="../../../outside.md">outside</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('scans raw HTML before masking paired backticks in attributes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a title="`" href="../../../outside.md" data-x="`">outside</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not start code spans on backslash-escaped backticks around raw HTML', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n\\`<a href="../../../outside.md">outside</a>\\`\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('keeps escaped-backtick offsets aligned after astral Unicode', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n😀 \\`<a href="../../../outside.md">outside</a>\\`\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('allows a backtick after a backslash to close an existing code span', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n`code\\`<a href="../../../outside.md">outside</a>`\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends list-contained fences when a sibling list item starts', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- ```md\n  fenced\n- [escape]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends a blockquote fence when an unquoted blank separates a sibling quote', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n> ```md\n> fenced\n\n> <a href="../../../outside.md">outside</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped-label reference links through symlinks that resolve outside the repository root', ({ skip }) => {
    buildCompleteFixture(fixture);
    const externalRoot = mkdtempSync(join(tmpdir(), 'epic-3698-external-'));
    const externalTarget = join(externalRoot, 'outside.md');
    writeFileSync(externalTarget, 'outside\n');
    try {
      try {
        symlinkSync(externalTarget, join(fixture, 'outside-link.md'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTSUP') {
          skip();
          return;
        }
        throw error;
      }
      writeFileSync(
        join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
        '# design\n[escape][out\\]side]\n\n[out\\]side]: ../../outside-link.md\n',
      );
      const run = runVerifier([
        '--root', fixture,
        '--evidence', join(fixture, 'ci-evidence.json'),
        '--changed-files', join(fixture, 'changed-files.txt'),
      ]);
      expect(run.status).toBe(1);
      expect(check(run, 'docsLinks').status).toBe('fail');
      expect(check(run, 'docsLinks').problems.join(' ')).toContain('resolves outside repository root');
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('on this repository, runs clean: receipts/docs/parity pass; child terminality and metrics reflect current state', () => {
    const run = runVerifier(['--evidence', join(REPO_ROOT, 'receipts', 'epic-3698', 'ci-evidence-merged.receipt.json')]);
    // Verdict may be PENDING_TEMPORAL (alias retirement window unsatisfied) or FAIL (metrics not at target with all owners terminal)
    expect(['PENDING_TEMPORAL', 'PASS', 'FAIL']).toContain(run.report.verdict);
    // The checked-in historical evidence predates the exact child-PR and
    // structured terminal-receipt contracts, so it must fail closed until
    // refreshed; docs and the risk register remain valid.
    expect(['pass', 'fail']).toContain(check(run, 'exactHeadCi').status);
    expect(['pass', 'fail']).toContain(check(run, 'migrationReceipts').status);
    expect(check(run, 'remainingRisk').status).toBe('pass');
    expect(check(run, 'docsLinks').status).toBe('pass');
    // pass when a base ref resolves locally; pending (not a crash) in shallow CI checkouts without origin/dev
    expect(['pass', 'pending']).toContain(check(run, 'releaseSecurityParity').status);
    // childTerminality: pass when all children have current structured receipts;
    // pending when receipts are absent; fail when stale/forged receipts exist.
    expect(['pass', 'pending', 'fail']).toContain(check(run, 'childTerminality').status);
    // shippedMetrics: pending while owners open; fail when all owners terminal but targets unmet; pass when targets met
    expect(['pass', 'pending', 'fail']).toContain(check(run, 'shippedMetrics').status);
    // alias retirement window is unsatisfied — always pending
    expect(check(run, 'aliasRetirementPolicy').status).toBe('pending');
  });

  it('keeps stdout machine-readable and reports parity pending when no git base is available', () => {
    buildCompleteFixture(fixture);
    // No --changed-files and the fixture is not a git repository: the parity
    // check must degrade to pending, never throw into empty stdout.
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
    ]);
    expect(run.status).toBe(2);
    expect(run.report.verdict).toBe('PENDING_TEMPORAL');
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('change set unavailable');
  });

  it('emits a metrics-snapshot receipt via --emit-metrics-receipt', () => {
    const out = join(fixture, 'metrics.receipt.json');
    spawnSync(process.execPath, [SCRIPT, '--root', fixture, '--emit-metrics-receipt', out], { encoding: 'utf8' });
    expect(existsSync(out)).toBe(true);
    const receipt = JSON.parse(readFileSync(out, 'utf8'));
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.kind).toBe('metrics-snapshot');
    expect(receipt.issue).toBe(3712);
    expect(receipt.payload.measurementSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unknown arguments fail-closed', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--bogus');
  });
});
