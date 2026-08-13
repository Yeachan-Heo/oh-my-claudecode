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

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// --- Epic contract configuration (issue #3712 acceptance surface) ---------

export const EPIC_CONTRACT = Object.freeze({
  epic: 3698,
  closureIssue: 3712,
  planningDoc: 'docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md',
  remainingRiskRegister: 'receipts/epic-3698/remaining-risk.json',
  receiptsDir: 'receipts/epic-3698',
  childIssues: Object.freeze([3702, 3703, 3704, 3705, 3706, 3707, 3708, 3709, 3710, 3711]),
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

function checkExactHeadCi(evidencePath) {
  const id = 'exactHeadCi';
  if (!evidencePath) {
    return {
      id,
      status: 'pending',
      details: 'no --evidence CI receipt supplied; exact-head CI evidence for child PRs is collected as prerequisites merge',
      problems: [],
    };
  }
  if (!existsSync(evidencePath)) {
    return { id, status: 'fail', details: `CI evidence file not found: ${evidencePath}`, problems: ['missing evidence file'] };
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    return { id, status: 'fail', details: `CI evidence is not valid JSON: ${error.message}`, problems: ['invalid JSON'] };
  }
  const problems = [];
  if (evidence.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  const prs = evidence.pullRequests ?? evidence.payload?.pullRequests;
  if (!Array.isArray(prs) || prs.length === 0) problems.push('pullRequests must be a non-empty array');
  for (const [index, pr] of (Array.isArray(prs) ? prs : []).entries()) {
    const label = `pullRequests[${index}]`;
    if (!isObject(pr)) { problems.push(`${label} must be an object`); continue; }
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) problems.push(`${label}.number must be a positive integer`);
    if (!isSha(pr.headSha)) problems.push(`${label}.headSha must be a 40-char lowercase hex SHA`);
    if (!Array.isArray(pr.checks) || pr.checks.length === 0) {
      problems.push(`${label}.checks must be a non-empty array (exact-head proof requires at least one check)`);
      continue;
    }
    for (const [ci, check] of pr.checks.entries()) {
      const clabel = `${label}.checks[${ci}]`;
      if (!isObject(check)) { problems.push(`${clabel} must be an object`); continue; }
      try { requiredString(check.name, `${clabel}.name`); } catch (error) { problems.push(error.message); }
      // Exact-head binding: a check may either pin the SHA it ran against
      // (check.sha) or carry an explicit exactHead: true attestation recorded
      // by a trusted collector at the PR head. Anything else is stale evidence
      // and is rejected.
      const boundBySha = isSha(check.sha);
      const boundByAttestation = check.exactHead === true && !boundBySha;
      if (boundBySha && isSha(pr.headSha) && check.sha !== pr.headSha) {
        problems.push(`${clabel} ran at ${check.sha}, not the exact PR head ${pr.headSha}`);
      } else if (!boundBySha && check.sha !== undefined) {
        problems.push(`${clabel}.sha must be a 40-char lowercase hex SHA when present`);
      } else if (!boundBySha && !boundByAttestation) {
        problems.push(`${clabel} must bind the exact head via .sha or exactHead: true`);
      }
      if (!['success', 'skipped', 'neutral'].includes(check.conclusion)) {
        problems.push(`${clabel}.conclusion must be success|skipped|neutral, got ${JSON.stringify(check.conclusion)}`);
      }
    }
  }
  return problems.length === 0
    ? { id, status: 'pass', details: `${prs.length} PR(s) verified green at exact head`, problems }
    : { id, status: 'fail', details: `${problems.length} exact-head CI problem(s)`, problems };
}

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

function checkDocsLinks(root, docPaths) {
  const id = 'docsLinks';
  const problems = [];
  let scanned = 0;
  for (const docPath of docPaths) {
    const absolute = join(root, docPath);
    if (!existsSync(absolute)) {
      // The planning doc lives on the planning branch until PR #3701 merges;
      // a missing doc that is not owned by this issue is pending, not broken.
      if (docPath === EPIC_CONTRACT.planningDoc) continue;
      problems.push(`document not found: ${docPath}`);
      continue;
    }
    scanned += 1;
    const text = readFileSync(absolute, 'utf8');
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue; // external or anchor
      const cleaned = target.split('#')[0];
      if (!cleaned) continue;
      const resolved = resolve(join(absolute, '..'), cleaned);
      if (!existsSync(resolved)) problems.push(`${docPath}: broken relative link ${target}`);
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
    const p = receipt.payload;
    if (!['merged', 'closed'].includes(p.state)) problems.push(`${label}.payload.state must be merged|closed`);
    try { requiredString(p.evidence, `${label}.payload.evidence`); } catch (error) { problems.push(error.message); }
    return { kind: receipt.kind, issue: receipt.issue, state: p.state };
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
function listChangedFiles(root, base, changedFilesArg) {
  if (changedFilesArg) {
    return { files: readFileSync(changedFilesArg, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) };
  }
  for (const candidate of [base, `origin/${base}`, 'HEAD^']) {
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${candidate}...HEAD`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { files: out.split('\n').map((l) => l.trim()).filter(Boolean), resolvedBase: candidate };
    } catch {
      // try the next base candidate
    }
  }
  return { unavailable: true };
}

function checkReleaseSecurityParity(root, base, changedFilesArg) {
  const id = 'releaseSecurityParity';
  const problems = [];
  const changeSet = listChangedFiles(root, base, changedFilesArg);
  if (changeSet.unavailable) {
    return {
      id,
      status: 'pending',
      details: `change set unavailable (no usable git base among ${base}, origin/${base}, HEAD^); run with --changed-files or a fetchable base ref to prove release/security parity`,
      problems,
    };
  }
  const files = changeSet.files;
  for (const file of files) {
    for (const pattern of EPIC_CONTRACT.forbiddenChangePatterns) {
      if (pattern.test(file)) problems.push(`change set touches release/publish authority surface: ${file}`);
    }
  }
  // Version bumps are release mutations; inspect package.json content diff.
  if (files.includes('package.json') && !changedFilesArg) {
    try {
      const diff = execFileSync('git', ['diff', `${changeSet.resolvedBase}...HEAD`, '--', 'package.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (/^[+-]\s*"version"\s*:/m.test(diff)) problems.push('change set mutates package.json "version" (release mutation)');
    } catch (error) {
      fail(`unable to inspect package.json diff: ${error.message}`);
    }
  }
  return problems.length === 0
    ? { id, status: 'pass', details: `no release/tag/publish mutation across ${files.length} changed file(s)`, problems }
    : { id, status: 'fail', details: `${problems.length} release/security parity violation(s)`, problems };
}

function checkChildTerminality(receiptsDir) {
  const id = 'childTerminality';
  const { receipts, missing } = readReceipts(receiptsDir);
  const terminal = new Set();
  if (!missing) {
    for (const r of receipts) {
      if (r.kind === 'child-terminal' && ['merged', 'closed'].includes(r.state)) terminal.add(r.issue);
    }
  }
  const problems = [];
  const pendingIssues = [];
  for (const issue of EPIC_CONTRACT.childIssues) {
    if (!terminal.has(issue)) pendingIssues.push(issue);
  }
  const gatesOpen = EPIC_CONTRACT.gateChildren.filter((issue) => !terminal.has(issue));
  const details = pendingIssues.length === 0
    ? 'all child issues have terminal evidence'
    : `awaiting terminal evidence for child issue(s): ${pendingIssues.join(', ')}`;
  return {
    id,
    status: pendingIssues.length === 0 ? 'pass' : 'pending',
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

  const childCheck = checkChildTerminality(receiptsDir);
  const terminalChildren = new Set(childCheck.terminal ?? []);
  const docPaths = args.docPaths ?? [
    EPIC_CONTRACT.planningDoc,
    'docs/design/ISSUE-3712-RELEASE-VERIFICATION.md',
    'receipts/epic-3698/README.md',
  ];

  const checks = [
    checkExactHeadCi(args.evidence),
    checkDocsLinks(root, docPaths),
    checkShippedMetrics(measured, terminalChildren),
    checkMigrationReceipts(receiptsDir),
    checkRetirementPolicy(receiptsDir),
    checkReleaseSecurityParity(root, args.base, args.changedFiles),
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
