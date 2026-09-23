#!/usr/bin/env node
// Build one `.github/generated-artifact-authorizations.json` entry for a release PR.
//
// The verifier (`scripts/verify-generated-artifact-authorization.mjs`) hashes the
// canonical generated-file closure of the PR: every `dist/` or `bridge/` path in the
// merge-base...head comparison, sorted by filename, serialized as
// `{status, filename, sha, previousFilename}`. Hand-writing 300+ records is how a
// release stalls, so this derives them from the local checkout instead.
//
// Blob shas are content-addressed, so re-authoring or re-signing the head commit
// without touching the tree leaves `generatedDelta` and `generatedFiles` valid and
// only `headSha` needs refreshing.
//
// Usage:
//   node scripts/build-generated-artifact-authorization.mjs \
//     --pull 4066 --base origin/main --head HEAD --target main \
//     --owner Yeachan-Heo --expires 2026-10-01T00:00:00Z
//
// Prints the entry to stdout; `--out <path>` writes it instead.

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}

const pullNumber = Number.parseInt(arg('pull') || '', 10);
const baseRef = arg('base', 'origin/main');
const headRef = arg('head', 'HEAD');
const targetRef = arg('target', 'main');
const owner = arg('owner', 'Yeachan-Heo');
const expiresAt = arg('expires');
const outPath = arg('out');

if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
  console.error('--pull <number> is required');
  process.exit(2);
}
if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
  console.error('--expires <ISO-8601 timestamp> is required');
  process.exit(2);
}

const mergeBaseSha = git(['merge-base', baseRef, headRef]);
const headSha = git(['rev-parse', headRef]);

const statusOf = code => {
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('C')) return 'copied';
  if (code === 'A') return 'added';
  if (code === 'D') return 'removed';
  return 'modified';
};

const raw = git(['diff', '--name-status', '--find-renames', `${mergeBaseSha}...${headSha}`, '--', 'dist', 'bridge']);
const records = [];
for (const line of raw ? raw.split('\n') : []) {
  if (!line.trim()) continue;
  const parts = line.split('\t');
  const status = statusOf(parts[0]);
  const renamed = status === 'renamed' || status === 'copied';
  const filename = renamed ? parts[2] : parts[1];
  const previousFilename = renamed ? parts[1] : null;
  // A removed path no longer exists at head, so its blob comes from the base side.
  const shaRef = status === 'removed' ? `${mergeBaseSha}:${filename}` : `${headSha}:${filename}`;
  records.push({ status, filename, sha: git(['rev-parse', shaRef]), previousFilename });
}

records.sort((left, right) => (left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0));

const entry = {
  pullNumber,
  targetRef,
  mergeBaseSha,
  headSha,
  owner,
  expiresAt,
  generatedDelta: {
    count: records.length,
    sha256: createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex'),
  },
  generatedFiles: records,
};

const serialized = `${JSON.stringify(entry, null, 2)}\n`;
if (outPath) {
  writeFileSync(outPath, serialized);
  console.error(`wrote ${outPath}: ${records.length} generated file(s), digest ${entry.generatedDelta.sha256}`);
} else {
  process.stdout.write(serialized);
}
