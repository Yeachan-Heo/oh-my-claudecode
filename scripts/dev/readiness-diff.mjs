// Differential check for changes to the team readiness paths: proves that the
// working tree (head) sends the same tmux keys as a base revision, or a
// subsequence of them, and never waits less.
//
// Usage (from any cwd):
//   node scripts/dev/readiness-diff.mjs [--base origin/dev] --set r5|trust [--out /tmp/readiness-diff-<set>]
//
// The base is checked out once as a detached worktree at
// $TMPDIR/omc-readiness-diff-<base sha> and reused while its tracked files are
// clean and its node_modules still follows the lockfile rule; otherwise it is
// recreated. To clear the cache by hand:
//   git worktree remove --force "$TMPDIR/omc-readiness-diff-<base sha>"
// Both trees run the head copy of
// src/team/__tests__/readiness-trace.harness.test.ts and its tmux mock against
// the head pane frame fixtures with tmux mocked, so neither run starts tmux or a provider.
// Writes base.json, head.json and summary.txt to --out; exits 0 only when
// summary.txt ends in RESULT PASS.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const HEAD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = join('src', 'team', '__tests__', 'readiness-trace.harness.test.ts');
const HARNESS_FILES = [HARNESS, join('src', 'team', '__tests__', 'helpers', 'readiness-trace-tmux.ts')];
const FIXTURE_ROOT = join(HEAD_ROOT, 'src', 'team', '__tests__', 'fixtures', 'pane-frames');

// Modules head must load for a set; a miss means head ran the base path.
const REQUIRED_HEAD_MODULES = { r5: [], trust: [] };

// Sets whose head may send keys the base did not, in cases where the base
// failed: there head has to keep going to succeed.
const HEAD_MAY_CONTINUE_WHERE_BASE_FAILED = new Set(['trust']);

// Cases where head may return sooner than base: in the trust set's stale
// case base answers the dead dialog first and head returns without a key.
const WAIT_MAY_SHORTEN = { trust: (baseCase) => baseCase.eventState === 'stale' };

const succeeded = (traceCase) => traceCase.result?.ok === true;

const STARTUP_WAIT_MAX_MS = 120_000;
const STARTUP_WAIT_DEFAULT_MS = 30_000;
// waitForStartupPaneReady's default poll interval.
const STARTUP_POLL_MS = 250;
const TRUST_MODES = ['immediate', 'batched', 'stale'];

// The product's own parser decides which values may lengthen the wait, so the
// comparator cannot read a value differently from it (6e4, unsafe integers).
const { resolveStartupReadyTimeoutMs } = await tsImport(
  pathToFileURL(join(HEAD_ROOT, 'src', 'team', 'ready-timeout.ts')).href, import.meta.url,
);

function readinessTimeoutAtDefault(raw) {
  const env = raw === null ? {} : { OMC_TEAM_READY_TIMEOUT_MS: raw };
  return resolveStartupReadyTimeoutMs(env) === STARTUP_WAIT_DEFAULT_MS;
}

// Set-specific review criteria, on top of the checks every set must pass.
const SET_CRITERIA = {
  r5: (pairs) => {
    const failures = [];
    for (const { id, base, head, sameKeys, sameResult } of pairs) {
      if (!sameKeys) failures.push(`${id} key sequence differs from base`);
      if (!sameResult) failures.push(`${id} result differs from base`);
      if (readinessTimeoutAtDefault(base.env.OMC_TEAM_READY_TIMEOUT_MS) && head.wait_ms !== base.wait_ms) {
        failures.push(`${id} wait changed although the variable cannot lengthen it`);
      }
      if (head.wait_ms > STARTUP_WAIT_MAX_MS) failures.push(`${id} head waited ${head.wait_ms}ms > ${STARTUP_WAIT_MAX_MS}ms`);
    }
    return failures;
  },
  // Claude Code's trust dialog, answered by a pane that applies each key as it
  // arrives (immediate) or the keys sent between captures together (batched),
  // or an answered dialog left above the live input prompt (stale).
  // Immediate: head sends what base sent and waits exactly one more poll, for
  // the capture that shows Yes focused. Batched: base confirms "No, exit" and
  // fails; head succeeds. Stale: head sends no key and returns what base did.
  trust: (pairs) => {
    const failures = [];
    for (const mode of TRUST_MODES) {
      if (!pairs.some(({ base }) => base.eventState === mode)) failures.push(`no ${mode} case`);
    }
    for (const { id, base, head, sameKeys, sameResult } of pairs) {
      if (!TRUST_MODES.includes(base.eventState)) failures.push(`${id} has unknown mode ${base.eventState}`);
      if (base.eventState === 'immediate') {
        if (!sameKeys) failures.push(`${id} key sequence differs from base`);
        if (!sameResult || !succeeded(head)) failures.push(`${id} result ${JSON.stringify(head.result)} differs from base or failed`);
        if (head.wait_ms !== base.wait_ms + STARTUP_POLL_MS) {
          failures.push(`${id} head waited ${head.wait_ms}ms, not base ${base.wait_ms}ms + one ${STARTUP_POLL_MS}ms poll`);
        }
      }
      if (base.eventState === 'stale') {
        if (head.keys.length > 0) failures.push(`${id} head sent ${head.keys.length} key(s) into the live prompt`);
        if (!sameResult) failures.push(`${id} result ${JSON.stringify(head.result)} differs from base`);
      }
      if (base.eventState === 'batched') {
        if (base.result?.reason !== 'selector_persistent') failures.push(`${id} base result ${JSON.stringify(base.result)} is not selector_persistent`);
        if (!succeeded(head)) failures.push(`${id} head result ${JSON.stringify(head.result)}`);
      }
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
  // Absolute, because the base harness runs with the base worktree as cwd.
  options.out = resolve(options.out ?? join('/tmp', `readiness-diff-${options.set}`));
  return options;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sameLockfile(baseRoot) {
  return readFileSync(join(HEAD_ROOT, 'package-lock.json'), 'utf8')
    === readFileSync(join(baseRoot, 'package-lock.json'), 'utf8');
}

// A cached base is trusted only when it is still exactly the base revision:
// the right commit, no tracked or untracked change besides the copied harness
// and the node_modules link, and node_modules linked to head when the
// lockfiles match or installed by npm ci when they do not.
function cachedBaseProblem(baseRoot, baseSha) {
  let headSha;
  try {
    headSha = git(baseRoot, 'rev-parse', 'HEAD');
  } catch {
    return 'not a git worktree';
  }
  if (headSha !== baseSha) return `at ${headSha}`;
  const allowed = new Set([...HARNESS_FILES.flatMap(file => [`?? ${file}`, ` M ${file}`]), '?? node_modules']);
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: baseRoot, encoding: 'utf8' })
    .split('\n').filter(line => line && !allowed.has(line));
  if (dirty.length > 0) return `changed files: ${dirty.slice(0, 5).join(', ')}`;
  const modules = join(baseRoot, 'node_modules');
  if (!existsSync(modules)) return undefined;
  const linked = lstatSync(modules).isSymbolicLink();
  if (sameLockfile(baseRoot)) {
    if (!linked || realpathSync(modules) !== realpathSync(join(HEAD_ROOT, 'node_modules'))) return 'node_modules is not the head link';
  } else if (linked || !existsSync(join(modules, '.package-lock.json'))) {
    return 'node_modules was not installed by npm ci';
  }
  return undefined;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function prepareBaseTree(baseSha) {
  const baseRoot = join(tmpdir(), `omc-readiness-diff-${baseSha}`);
  const problem = existsSync(baseRoot) ? cachedBaseProblem(baseRoot, baseSha) : undefined;
  if (problem) {
    console.warn(`recreating ${baseRoot}: ${problem}`);
    const modules = join(baseRoot, 'node_modules');
    if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
    execFileSync('git', ['worktree', 'remove', '--force', baseRoot], { cwd: HEAD_ROOT, stdio: 'ignore' });
  }
  if (!existsSync(baseRoot)) {
    execFileSync('git', ['worktree', 'add', '--detach', baseRoot, baseSha], { cwd: HEAD_ROOT, stdio: 'ignore' });
  }
  if (!existsSync(join(baseRoot, 'node_modules'))) {
    if (sameLockfile(baseRoot)) symlinkSync(join(HEAD_ROOT, 'node_modules'), join(baseRoot, 'node_modules'), 'dir');
    else execFileSync('npm', ['ci'], { cwd: baseRoot, stdio: 'inherit' });
  }
  // The native addon is a local build product that git does not carry; a
  // cached copy goes stale when head rebuilds it.
  const nativeDir = join(HEAD_ROOT, 'native');
  if (existsSync(nativeDir)) {
    mkdirSync(join(baseRoot, 'native'), { recursive: true });
    for (const name of readdirSync(nativeDir).filter(entry => entry.endsWith('.node'))) {
      const [source, copy] = [join(nativeDir, name), join(baseRoot, 'native', name)];
      if (!existsSync(copy) || sha256(copy) !== sha256(source)) copyFileSync(source, copy);
    }
  }
  for (const file of HARNESS_FILES) {
    mkdirSync(dirname(join(baseRoot, file)), { recursive: true });
    copyFileSync(join(HEAD_ROOT, file), join(baseRoot, file));
  }
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

export function compare(set, base, head) {
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
    const sameResult = isDeepStrictEqual(baseCase.result, headCase.result);
    const identical = sameKeys && sameResult && baseCase.wait_ms === headCase.wait_ms;
    pairs.push({ id, base: baseCase, head: headCase, sameKeys, sameResult });
    if (identical) counts.identical++;
    const headMayContinue = HEAD_MAY_CONTINUE_WHERE_BASE_FAILED.has(set) && !succeeded(baseCase);
    if (!headMayContinue && !isSubsequence(headKeys, baseKeys)) counts.head_only_keys++;
    if (!isSubsequence(baseKeys, headKeys)) counts.base_only_keys++;
    if (headCase.wait_ms < baseCase.wait_ms && !WAIT_MAY_SHORTEN[set]?.(baseCase)) counts.wait_shorter++;
    const [baseNudges, headNudges] = [baseCase.nudges ?? [], headCase.nudges ?? []];
    if (headNudges.length < baseNudges.length) counts.nudge_missing++;
    headNudges.slice(0, baseNudges.length).forEach((nudge, index) => {
      counts.nudge_delay_max_ms = Math.max(counts.nudge_delay_max_ms, nudge.at_ms - baseNudges[index].at_ms);
    });
    if (!identical) {
      const parts = [];
      if (!sameKeys) parts.push(`keys base=${baseKeys.length} head=${headKeys.length}`);
      if (!sameResult) {
        parts.push(`result base=${JSON.stringify(baseCase.result)} head=${JSON.stringify(headCase.result)}`);
      }
      if (baseCase.wait_ms !== headCase.wait_ms) parts.push(`wait_ms base=${baseCase.wait_ms} head=${headCase.wait_ms}`);
      differences.push(`${id} ${parts.join(' ')}`);
    }
    for (const [side, traceCase] of [['base', baseCase], ['head', headCase]]) {
      // An unrecognized command may be a key send the mock failed to read.
      if (traceCase.unknown_commands.length > 0) {
        failures.push(`${id} ${side} ran ${traceCase.unknown_commands.length} unrecognized tmux command(s)`);
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

export function summarize({ set, baseSha, headSha, base, head }) {
  const { counts, controls, differences, failures, cases } = compare(set, base, head);
  return [
    `readiness-diff base=${baseSha} head=${headSha} set=${set}`,
    `cases=${cases} control_cases=${controls} base_keys=${sentCount(base)} head_keys=${sentCount(head)}`,
    `identical=${counts.identical} head_only_keys=${counts.head_only_keys} base_only_keys=${counts.base_only_keys} ` +
      `wait_shorter=${counts.wait_shorter} nudge_missing=${counts.nudge_missing} nudge_delay_max_ms=${counts.nudge_delay_max_ms}`,
    `differences: ${differences.length}`,
    ...differences.map(line => `  ${line}`),
    ...failures.map(line => `failure: ${line}`),
    `RESULT ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseSha = git(HEAD_ROOT, 'rev-parse', '--verify', `${options.base}^{commit}`);
  const headSha = git(HEAD_ROOT, 'rev-parse', 'HEAD') + (git(HEAD_ROOT, 'status', '--porcelain') ? '-dirty' : '');
  mkdirSync(options.out, { recursive: true });
  const baseRoot = prepareBaseTree(baseSha);
  const base = runHarness(baseRoot, options.set, join(options.out, 'base.json'));
  const head = runHarness(HEAD_ROOT, options.set, join(options.out, 'head.json'));
  const summary = summarize({ set: options.set, baseSha, headSha, base, head });
  writeFileSync(join(options.out, 'summary.txt'), `${summary}\n`);
  console.log(summary);
  process.exit(summary.endsWith('RESULT PASS') ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
