#!/usr/bin/env node
/** Exercise the supplied built/package CLI, never a source import. POSIX only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

const report = { status: 'FAIL', platform: process.platform, arch: process.arch, node: process.version, cases: [] };
const running = new Set();
const commandMarkers = new Set();
let base;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function killGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
}
function killCommand(marker) {
  if (!existsSync(marker)) return;
  const pid = Number(readFileSync(marker, 'utf8'));
  if (Number.isSafeInteger(pid) && pid > 1) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* command already exited */ }
  }
}
function start(entry, args, cwd, env) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  let stdout = '', stderr = '', finished = false;
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-100_000); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-100_000); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(child); }, 45_000);
  const done = new Promise((resolve) => {
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killGroup(child);
      running.delete(child);
      resolve({ ...result, timedOut, stdout, stderr });
    };
    child.on('error', (error) => finish({ code: null, error: error.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
  return { child, done, get finished() { return finished; } };
}
function records(runDir) {
  const file = join(runDir, 'journal.jsonl');
  if (!existsSync(file)) return [];
  // Ignore only an in-flight partial final line while waiting for the commit.
  return readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
}
function count(file) { return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0; }
function success(result) { assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.timedOut, false); }

try {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-graph-contained-fs.mjs /absolute/path/to/CLI');
  assert.notEqual(process.platform, 'win32', 'This harness requires POSIX process groups');
  assert.ok(isAbsolute(process.argv[2]), 'CLI path must be absolute');
  const entry = realpathSync(process.argv[2]);
  let packageRoot = dirname(entry);
  while (!existsSync(join(packageRoot, 'package.json'))) {
    const parent = dirname(packageRoot);
    assert.notEqual(parent, packageRoot, 'No package.json found above CLI');
    packageRoot = parent;
  }
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  Object.assign(report, { entry, packageRoot, packageName: metadata.name, packageVersion: metadata.version,
    entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex') });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'omc-contained-acceptance-')));
  const cwd = join(base, 'unrelated-cwd');
  mkdirSync(cwd);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(base, 'claude-config') };
  for (const key of Object.keys(env)) if (key.startsWith('OMC_') || key === 'CLAUDECODE' || key === 'NODE_OPTIONS') delete env[key];
  report.versionCommand = await start(entry, ['--version'], cwd, env).done;
  success(report.versionCommand);

  for (const crash of [false, true]) {
    const name = crash ? 'sigkill-resume' : 'fresh-and-completed-rerun';
    const fixture = join(base, name);
    mkdirSync(fixture);
    const runsRoot = join(fixture, 'runs');
    const runId = `acceptance-${name}`;
    const runDir = join(runsRoot, runId);
    const firstMarker = join(fixture, 'first.marker');
    const finalMarker = join(fixture, 'final.marker');
    const started = join(fixture, 'second.started');
    commandMarkers.add(started);
    const gate = join(fixture, 'continue');
    // exec makes Node the detached command-group leader, recorded by its fixture.
    const command = (source) => `exec ${quote(process.execPath)} -e ${quote(source)}`;
    const descriptor = {
      descriptor_version: 1, run_id: runId, revision_id: 'rev-acceptance-1', goal: 'local packaged CLI persistence acceptance',
      nodes: [
        { id: 'first', kind: 'command', title: 'First marker', timeout_ms: 30_000, max_attempts: 3,
          effect_policy: { policy: 'side_effect_free' },
          command: command(`require('node:fs').appendFileSync(${JSON.stringify(firstMarker)}, 'executed\\n')`) },
        { id: 'last', kind: 'command', title: 'Bounded gate and final marker', timeout_ms: 30_000, max_attempts: 3,
          effect_policy: { policy: 'side_effect_free' },
          command: command(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},String(process.pid));const deadline=Date.now()+25000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);fs.appendFileSync(${JSON.stringify(finalMarker)},'executed\\n')}else if(Date.now()>deadline){clearInterval(timer);process.exitCode=1}},40)`) },
      ],
      edges: [{ id: 'first-last', kind: 'fixed', from: 'first', to: 'last' }],
      entry_node_ids: ['first'], concurrency_limit: 1, terminal_verification_node_id: 'last',
    };
    const descriptorPath = join(fixture, 'graph.json');
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    if (!crash) writeFileSync(gate, 'continue');
    const args = ['graph', 'run', descriptorPath, '--runs-root', runsRoot];
    const first = start(entry, args, cwd, env);
    const evidence = { name };
    report.cases.push(evidence);
    if (crash) {
      const deadline = Date.now() + 30_000;
      while (!(existsSync(started) && records(runDir).some((r) => r.transition.node_id === 'first'))) {
        assert.ok(Date.now() < deadline, 'Timed out waiting for first commit and second command start');
        assert.equal(first.finished, false, `CLI exited before crash point: ${JSON.stringify(await Promise.race([first.done, Promise.resolve(null)]))}`);
        await sleep(40);
      }
      evidence.epochBeforeCrash = records(runDir).find((r) => r.transition.node_id === 'first').epoch;
      killGroup(first.child);
      killCommand(started);
      evidence.initial = await first.done;
      rmSync(started, { force: true });
      assert.equal(evidence.initial.signal, 'SIGKILL');
      const lock = join(runDir, 'owner.lock');
      assert.ok(existsSync(lock), 'Crash must leave an owner lock');
      const past = new Date(Date.now() - 120_000);
      utimesSync(lock, past, past);
      evidence.deadOwnerLockBackdatedMs = 120_000;
      writeFileSync(gate, 'continue');
    } else {
      evidence.initial = await first.done;
      success(evidence.initial);
    }
    evidence.resume = await start(entry, args, cwd, env).done;
    success(evidence.resume);
    commandMarkers.delete(started);
    const journalText = readFileSync(join(runDir, 'journal.jsonl'), 'utf8');
    assert.ok(journalText.endsWith('\n'), 'Journal must have complete final record');
    const journal = records(runDir);
    assert.deepEqual(journal.map((r) => r.transition.node_id), ['first', 'last']);
    assert.equal(count(firstMarker), 1, 'Completed first command must not re-execute');
    assert.equal(count(finalMarker), 1, 'Final command must execute once');
    if (crash) assert.ok(journal[1].epoch > journal[0].epoch, 'Takeover must advance epoch');
    for (const artifact of ['descriptor.json', 'projection.json', 'owner.epoch']) assert.ok(existsSync(join(runDir, artifact)), `Missing ${artifact}`);
    assert.equal(existsSync(join(runDir, 'owner.lock')), false, 'Successful completion must release ownership');
    Object.assign(evidence, { status: 'PASS', firstExecutions: count(firstMarker), finalExecutions: count(finalMarker),
      committedNodes: journal.map((r) => r.transition.node_id), epochs: journal.map((r) => r.epoch),
      ownerEpoch: readFileSync(join(runDir, 'owner.epoch'), 'utf8') });
  }
  if (process.platform === 'darwin') {
    // Never rename/remove an asset from the supplied package: it may be a live install.
    const isolatedPackage = join(base, 'missing-backend-package');
    mkdirSync(isolatedPackage);
    for (const item of ['package.json', 'bin', 'bridge', 'dist', 'native', 'agents']) {
      const source = join(packageRoot, item);
      if (existsSync(source)) cpSync(source, join(isolatedPackage, item), { recursive: true, dereference: true });
    }
    let dependencyRoot = packageRoot;
    while (!existsSync(join(dependencyRoot, 'node_modules'))) {
      const parent = dirname(dependencyRoot);
      assert.notEqual(parent, dependencyRoot, 'Cannot locate installed dependencies for isolated backend test');
      dependencyRoot = parent;
    }
    symlinkSync(join(dependencyRoot, 'node_modules'), join(isolatedPackage, 'node_modules'), 'dir');
    const missingBinary = join(isolatedPackage, 'native', `contained-fs-darwin-${process.arch}.node`);
    assert.ok(existsSync(missingBinary), 'Candidate must include the active architecture backend before omission');
    rmSync(missingBinary);
    const runId = 'acceptance-missing-backend';
    const runsRoot = join(base, 'missing-backend-runs');
    const marker = join(base, 'missing-backend-command.marker');
    const descriptorPath = join(base, 'missing-backend.json');
    writeFileSync(descriptorPath, JSON.stringify({
      descriptor_version: 1, run_id: runId, revision_id: 'rev-missing-1', goal: 'Refuse missing backend before persistence',
      nodes: [{ id: 'last', kind: 'command', title: 'Must never execute', timeout_ms: 5000, max_attempts: 1,
        effect_policy: { policy: 'side_effect_free' },
        command: `exec ${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`)}` }],
      edges: [], entry_node_ids: ['last'], concurrency_limit: 1, terminal_verification_node_id: 'last',
    }));
    const result = await start(join(isolatedPackage, relative(packageRoot, entry)),
      ['graph', 'run', descriptorPath, '--runs-root', runsRoot], cwd, env).done;
    const evidence = { name: 'missing-backend-fails-before-persistence', result };
    report.cases.push(evidence);
    assert.ok(Number.isInteger(result.code) && result.code !== 0, JSON.stringify(result));
    assert.equal(result.timedOut, false);
    assert.match(result.stderr, /contained[^\n]*unavailable|contained[^\n]*refusing pathname fallback/i);
    assert.equal(existsSync(runsRoot), false, 'Missing backend must fail before creating persistence root');
    assert.equal(existsSync(marker), false, 'Missing backend must prevent command execution');
    Object.assign(evidence, { status: 'PASS', persistenceRootCreated: false, commandExecuted: false });
  }
  report.status = 'PASS';
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  for (const child of running) killGroup(child);
  for (const marker of commandMarkers) killCommand(marker);
  if (base) rmSync(base, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
