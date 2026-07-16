#!/usr/bin/env node
/**
 * Candidate-side containment only. This credential-free Git classifier is
 * replaceable by a pull-request branch and never authorizes generated files.
 */
import { spawnSync } from 'node:child_process';

const GENERATED_ROOTS = ['dist', 'bridge'];
const SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function git(args, { binary = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    encoding: binary ? 'buffer' : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`git could not start while ${args[0]}`);
  if (result.status !== 0 && !allowFailure) fail(`git failed while ${args[0]}`);
  return result;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--base' && flag !== '--head') fail('expected exactly one --base SHA and one --head SHA');
    if (values.has(flag) || index + 1 === argv.length) fail('expected exactly one --base SHA and one --head SHA');
    const value = argv[index + 1];
    if (!SHA.test(value)) fail('base and head must be 40-character lowercase hexadecimal commit SHAs');
    values.set(flag, value);
    index += 1;
  }
  if (values.size !== 2) fail('expected exactly one --base SHA and one --head SHA');
  return { base: values.get('--base'), head: values.get('--head') };
}

function canonicalCommit(sha, label) {
  const result = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { allowFailure: true });
  if (result.status !== 0) fail(`${label} commit is not available`);
  const canonical = result.stdout.trim();
  if (!SHA.test(canonical)) fail(`${label} commit did not resolve to a canonical SHA`);
  return canonical;
}

function requireAncestor(ancestor, descendant, label) {
  if (git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true }).status !== 0) {
    fail(`${label} is not an ancestor of the required commit`);
  }
}

function diagnosticPath(path) {
  return JSON.stringify(path);
}

function main() {
  const { base, head } = parseArguments(process.argv.slice(2));
  const canonicalBase = canonicalCommit(base, 'base');
  const canonicalHead = canonicalCommit(head, 'head');
  const checkedOutHead = canonicalCommit('HEAD', 'checked-out HEAD');
  if (checkedOutHead !== canonicalHead) fail('checked-out HEAD does not match --head');

  const mergeBaseResult = git(['merge-base', '--all', canonicalBase, canonicalHead], { allowFailure: true });
  const mergeBases = mergeBaseResult.status === 0
    ? mergeBaseResult.stdout.trim().split(/\s+/).filter(Boolean)
    : [];
  if (mergeBases.length === 0) fail('no common merge base exists between --base and --head');
  if (mergeBases.length !== 1) fail(`ambiguous merge base: expected one, found ${mergeBases.length}`);
  const mergeBase = canonicalCommit(mergeBases[0], 'merge base');
  requireAncestor(mergeBase, canonicalBase, 'merge base');
  requireAncestor(mergeBase, canonicalHead, 'merge base');

  const diff = git([
    'diff', '--name-only', '-z', '--no-renames', `${mergeBase}..${canonicalHead}`, '--', ...GENERATED_ROOTS,
  ], { binary: true });
  const paths = diff.stdout.toString('utf8').split('\0').filter(Boolean);
  if (paths.length === 0) process.exit(0);

  process.stderr.write(
    `OWNER_CONFIRMATION_REQUIRED: candidate generated delta: ${paths.map(diagnosticPath).join(', ')}\n`,
  );
  process.exit(1);
}

main();
