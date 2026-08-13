import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function runVerifier(args: string[], cwd = REPO_ROOT): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
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

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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
  for (const issue of ALL_CHILDREN) {
    writeJson(join(receipts, `child-${issue}-terminal.receipt.json`), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue,
      createdAt: '2026-08-12T00:00:00Z',
      payload: { state: 'merged', evidence: `PR for #${issue} merged with green exact-head CI` },
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

  const head = 'a'.repeat(40);
  writeJson(join(root, 'ci-evidence.json'), {
    schemaVersion: 1,
    kind: 'ci-evidence',
    issue: 3712,
    createdAt: '2026-08-12T00:00:00Z',
    payload: {
      collector: 'test-fixture-collector',
      pullRequests: [
        {
          number: 1,
          headSha: head,
          checks: [
            { name: 'CI / Test', conclusion: 'success', sha: head },
            { name: 'CI / Lint', conclusion: 'skipped', exactHead: true },
          ],
        },
      ],
    },
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
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.report.verdict).toBe('PASS');
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

  it('rejects checks without exact-head binding and non-green conclusions', () => {
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
    expect(problems).toContain('exact head');
    expect(problems).toContain('failure');
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

  it('on this repository, runs clean: receipts/docs/parity pass; child terminality and metrics reflect current state', () => {
    const run = runVerifier(['--evidence', join(REPO_ROOT, 'receipts', 'epic-3698', 'ci-evidence-merged.receipt.json')]);
    // Verdict may be PENDING_TEMPORAL (alias retirement window unsatisfied) or FAIL (metrics not at target with all owners terminal)
    expect(['PENDING_TEMPORAL', 'PASS', 'FAIL']).toContain(run.report.verdict);
    // exactHeadCi, migrationReceipts, remainingRisk, docsLinks always pass
    expect(check(run, 'exactHeadCi').status).toBe('pass');
    expect(check(run, 'migrationReceipts').status).toBe('pass');
    expect(check(run, 'remainingRisk').status).toBe('pass');
    expect(check(run, 'docsLinks').status).toBe('pass');
    // pass when a base ref resolves locally; pending (not a crash) in shallow CI checkouts without origin/dev
    expect(['pass', 'pending']).toContain(check(run, 'releaseSecurityParity').status);
    // childTerminality: pass when all children have terminal receipts; pending otherwise
    expect(['pass', 'pending']).toContain(check(run, 'childTerminality').status);
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
