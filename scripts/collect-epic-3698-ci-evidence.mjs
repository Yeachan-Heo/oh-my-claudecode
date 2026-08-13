#!/usr/bin/env node
// Collects exact-head CI evidence for epic #3698 child PRs via `gh` and emits
// the JSON evidence document consumed by scripts/verify-epic-3698-closure.mjs
// (--evidence). Read-only against GitHub; never mutates PRs, branches, or
// releases. Each check is attested at the PR head OID reported by gh at
// collection time (exactHead: true); the verifier rejects checks whose
// recorded sha disagrees with the PR head.
//
// Usage:
//   node scripts/collect-epic-3698-ci-evidence.mjs --prs 3701,3715 --out <path>
//   node scripts/collect-epic-3698-ci-evidence.mjs --all-children --out <path>

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function fail(message) {
  process.stderr.write(`collect-epic-3698-ci-evidence: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { prs: null, allChildren: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--prs': args.prs = argv[++i]?.split(',').map((s) => Number(s.trim())).filter(Number.isSafeInteger); break;
      case '--all-children': args.allChildren = true; break;
      case '--out': args.out = argv[++i]; break;
      default: fail(`unknown argument: ${argv[i]}`);
    }
  }
  if (!args.out) fail('--out is required');
  if (!args.allChildren && (!args.prs || args.prs.length === 0)) fail('--prs or --all-children is required');
  return args;
}

const CHILD_ISSUES = [3702, 3703, 3704, 3705, 3706, 3707, 3708, 3709, 3710, 3711];

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function collectPr(number) {
  const pr = ghJson(['pr', 'view', String(number), '--json', 'number,headRefOid,state,statusCheckRollup']);
  const checks = (pr.statusCheckRollup ?? [])
    .filter((c) => (c.workflowName || c.context) && (c.conclusion || c.status))
    .map((c) => ({
      name: c.workflowName ? `${c.workflowName} / ${c.name}` : c.context,
      conclusion: String(c.conclusion ?? c.status).toLowerCase(),
      sha: pr.headRefOid,
    }));
  return { number: pr.number, headSha: pr.headRefOid, state: pr.state, checks };
}

function findChildPrs() {
  const prs = ghJson(['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,title,state,headRefName']);
  const found = [];
  for (const issue of CHILD_ISSUES) {
    const needle = `#${issue}`;
    const matches = prs.filter((p) => p.title.includes(needle) || p.headRefName.includes(`issue-${issue}`));
    if (matches.length > 0) found.push(matches.map((m) => m.number));
  }
  return found.flat();
}

const args = parseArgs(process.argv.slice(2));
const numbers = args.allChildren ? findChildPrs() : args.prs;
if (numbers.length === 0) fail('no child PRs found');
const pullRequests = numbers.map(collectPr);
const evidence = {
  schemaVersion: 1,
  kind: 'ci-evidence',
  issue: 3712,
  createdAt: new Date().toISOString(),
  payload: {
    collector: 'scripts/collect-epic-3698-ci-evidence.mjs (gh pr view statusCheckRollup at headRefOid)',
    pullRequests,
  },
};
writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`collected exact-head CI evidence for PR(s): ${numbers.join(', ')}\n`);
