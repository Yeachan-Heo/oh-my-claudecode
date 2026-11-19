// Differential check for changes to the team readiness paths: proves that the
// working tree (head) sends the same tmux keys as a base revision, or a
// subsequence of them, and never waits less.
//
// Usage (from any cwd):
//   node scripts/dev/readiness-diff.mjs [--base origin/dev] --set r5 [--out /tmp/readiness-diff-r5]
//
// The base is checked out once as a detached worktree under $TMPDIR and
// reused. Both trees run the head copy of
// src/team/__tests__/readiness-trace.harness.test.ts against the head pane
// frame fixtures with tmux mocked, so neither run starts tmux or a provider.
// Writes base.json, head.json and summary.txt to --out; exits 0 only when
// summary.txt ends in RESULT PASS.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HEAD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = join('src', 'team', '__tests__', 'readiness-trace.harness.test.ts');
const FIXTURE_ROOT = join(HEAD_ROOT, 'src', 'team', '__tests__', 'fixtures', 'pane-frames');

// Modules head must load for a set; a miss means head ran the base path.
const REQUIRED_HEAD_MODULES = { r5: [] };

const STARTUP_WAIT_MAX_MS = 120_000;

function readinessTimeoutBelowFloor(raw) {
  if (raw === null) return true;
  const trimmed = raw.trim();
  return !/^[+-]?\d+$/.test(trimmed) || Number(trimmed) < 30_000;
}

// Set-specific review criteria, on top of the checks every set must pass.
const SET_CRITERIA = {
  r5: (pairs) => {
    const failures = [];
    for (const { id, base, head, identical } of pairs) {
      if (readinessTimeoutBelowFloor(base.env.OMC_TEAM_READY_TIMEOUT_MS) && !identical) {
        failures.push(`${id} differs although the variable cannot lengthen the wait`);
      }
      if (head.wait_ms > STARTUP_WAIT_MAX_MS) failures.push(`${id} head waited ${head.wait_ms}ms > ${STARTUP_WAIT_MAX_MS}ms`);
    }
    return failures;
  },
};

function parseArgs(argv) {
  const options = { base: 'origin/dev', set: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--base') options.base = value;
    else if (flag === '--set') options.set = value;
    else if (flag === '--out') options.out = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.set || !Object.hasOwn(SET_CRITERIA, options.set)) {
    throw new Error(`--set must be one of: ${Object.keys(SET_CRITERIA).join(', ')}`);
  }
  options.out ??= join('/tmp', `readiness-diff-${options.set}`);
  return options;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function prepareBaseTree(baseSha) {
  const baseRoot = join(tmpdir(), `omc-readiness-diff-${baseSha}`);
  if (!existsSync(baseRoot)) {
    execFileSync('git', ['worktree', 'add', '--detach', baseRoot, baseSha], { cwd: HEAD_ROOT, stdio: 'ignore' });
  } else if (git(baseRoot, 'rev-parse', 'HEAD') !== baseSha) {
    throw new Error(`${baseRoot} is not at ${baseSha}; remove it with git worktree remove`);
  }
  if (!existsSync(join(baseRoot, 'node_modules'))) {
    const sameLock = readFileSync(join(HEAD_ROOT, 'package-lock.json'), 'utf8')
      === readFileSync(join(baseRoot, 'package-lock.json'), 'utf8');
    if (sameLock) symlinkSync(join(HEAD_ROOT, 'node_modules'), join(baseRoot, 'node_modules'), 'dir');
    else execFileSync('npm', ['ci'], { cwd: baseRoot, stdio: 'inherit' });
  }
  // The native addon is a local build product that git does not carry.
  const nativeDir = join(HEAD_ROOT, 'native');
  if (existsSync(nativeDir)) {
    mkdirSync(join(baseRoot, 'native'), { recursive: true });
    for (const name of readdirSync(nativeDir).filter(entry => entry.endsWith('.node'))) {
      if (!existsSync(join(baseRoot, 'native', name))) copyFileSync(join(nativeDir, name), join(baseRoot, 'native', name));
    }
  }
  mkdirSync(dirname(join(baseRoot, HARNESS)), { recursive: true });
  copyFileSync(join(HEAD_ROOT, HARNESS), join(baseRoot, HARNESS));
  return baseRoot;
}

function runHarness(root, set, outFile) {
  const env = { ...process.env, READINESS_TRACE_OUT: outFile, READINESS_TRACE_SET: set, READINESS_FIXTURE_ROOT: FIXTURE_ROOT };
  delete env.OMC_TEAM_READY_TIMEOUT_MS;
  const run = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', HARNESS], {
    cwd: root, env, encoding: 'utf8',
  });
  if (run.status !== 0 || !existsSync(outFile)) {
    throw new Error(`harness failed in ${root} (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

const keySequence = (traceCase) => traceCase.keys.map(key => JSON.stringify([key.fn, key.pane, key.guarded, key.keys]));
const sentCount = (trace) => trace.cases.reduce((sum, traceCase) => sum + traceCase.keys.length, 0);

function isSubsequence(candidate, of) {
  let index = 0;
  for (const item of of) if (index < candidate.length && candidate[index] === item) index++;
  return index === candidate.length;
}

function compare(set, base, head) {
  const failures = [];
  const differences = [];
  const baseCases = new Map(base.cases.map(traceCase => [traceCase.case, traceCase]));
  const headCases = new Map(head.cases.map(traceCase => [traceCase.case, traceCase]));
  for (const id of baseCases.keys()) if (!headCases.has(id)) failures.push(`${id} missing on head`);
  for (const id of headCases.keys()) if (!baseCases.has(id)) failures.push(`${id} missing on base`);

  const counts = { identical: 0, head_only_keys: 0, base_only_keys: 0, wait_shorter: 0, nudge_missing: 0, nudge_delay_max_ms: 0 };
  const pairs = [];
  for (const [id, baseCase] of baseCases) {
    const headCase = headCases.get(id);
    if (!headCase) continue;
    const [baseKeys, headKeys] = [keySequence(baseCase), keySequence(headCase)];
    const sameKeys = isDeepStrictEqual(baseKeys, headKeys);
    const identical = sameKeys && isDeepStrictEqual(baseCase.result, headCase.result) && baseCase.wait_ms === headCase.wait_ms;
    pairs.push({ id, base: baseCase, head: headCase, identical });
    if (identical) counts.identical++;
    if (!isSubsequence(headKeys, baseKeys)) counts.head_only_keys++;
    if (!isSubsequence(baseKeys, headKeys)) counts.base_only_keys++;
    if (headCase.wait_ms < baseCase.wait_ms) counts.wait_shorter++;
    const [baseNudges, headNudges] = [baseCase.nudges ?? [], headCase.nudges ?? []];
    if (headNudges.length < baseNudges.length) counts.nudge_missing++;
    headNudges.slice(0, baseNudges.length).forEach((nudge, index) => {
      counts.nudge_delay_max_ms = Math.max(counts.nudge_delay_max_ms, nudge.at_ms - baseNudges[index].at_ms);
    });
    if (!identical) {
      const parts = [];
      if (!sameKeys) parts.push(`keys base=${baseKeys.length} head=${headKeys.length}`);
      if (!isDeepStrictEqual(baseCase.result, headCase.result)) {
        parts.push(`result base=${JSON.stringify(baseCase.result)} head=${JSON.stringify(headCase.result)}`);
      }
      if (baseCase.wait_ms !== headCase.wait_ms) parts.push(`wait_ms base=${baseCase.wait_ms} head=${headCase.wait_ms}`);
      differences.push(`${id} ${parts.join(' ')}`);
    }
    for (const [side, traceCase] of [['base', baseCase], ['head', headCase]]) {
      if (traceCase.unknown_commands.some(command => command.includes('send-keys'))) {
        failures.push(`${id} ${side} sent keys outside the recorded paths`);
      }
    }
  }

  const controls = base.cases.filter(traceCase => traceCase.control);
  if (controls.length === 0) failures.push('no positive control case');
  for (const control of controls) {
    if (control.keys.length === 0) failures.push(`control ${control.case} recorded no keys on base`);
  }
  if (sentCount(base) === 0) failures.push('base recorded no keys at all');
  for (const name of REQUIRED_HEAD_MODULES[set]) {
    if (!head.loaded_modules.includes(name)) failures.push(`head did not load ${name}`);
  }
  if (counts.head_only_keys > 0) failures.push(`head_only_keys=${counts.head_only_keys}`);
  if (counts.wait_shorter > 0) failures.push(`wait_shorter=${counts.wait_shorter}`);
  if (counts.nudge_missing > 0) failures.push(`nudge_missing=${counts.nudge_missing}`);
  failures.push(...SET_CRITERIA[set](pairs));
  return { counts, controls: controls.length, differences, failures, cases: pairs.length };
}

const options = parseArgs(process.argv.slice(2));
const baseSha = git(HEAD_ROOT, 'rev-parse', '--verify', `${options.base}^{commit}`);
const headSha = git(HEAD_ROOT, 'rev-parse', 'HEAD') + (git(HEAD_ROOT, 'status', '--porcelain') ? '-dirty' : '');
mkdirSync(options.out, { recursive: true });
const baseRoot = prepareBaseTree(baseSha);
const base = runHarness(baseRoot, options.set, join(options.out, 'base.json'));
const head = runHarness(HEAD_ROOT, options.set, join(options.out, 'head.json'));
const { counts, controls, differences, failures, cases } = compare(options.set, base, head);

const summary = [
  `readiness-diff base=${baseSha} head=${headSha} set=${options.set}`,
  `cases=${cases} control_cases=${controls} base_keys=${sentCount(base)} head_keys=${sentCount(head)}`,
  `identical=${counts.identical} head_only_keys=${counts.head_only_keys} base_only_keys=${counts.base_only_keys} ` +
    `wait_shorter=${counts.wait_shorter} nudge_missing=${counts.nudge_missing} nudge_delay_max_ms=${counts.nudge_delay_max_ms}`,
  `differences: ${differences.length}`,
  ...differences.map(line => `  ${line}`),
  ...failures.map(line => `failure: ${line}`),
  `RESULT ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
].join('\n');
writeFileSync(join(options.out, 'summary.txt'), `${summary}\n`);
console.log(summary);
process.exit(failures.length === 0 ? 0 : 1);
