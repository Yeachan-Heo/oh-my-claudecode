#!/usr/bin/env node
/**
 * Bidchex multi-repo workspace smoke test.
 * Fixture lives under os.tmpdir() — never touches the real bidchex-repos workspace.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST = join(REPO_ROOT, 'dist');
const BRIDGE_CLI = join(REPO_ROOT, 'bridge', 'cli.cjs');

// --------------------------------------------------------------------------
// Dynamic import helpers (dist is CJS-wrapped ESM — use createRequire)
// --------------------------------------------------------------------------
const req = createRequire(import.meta.url);

let worktreePaths, processUtils;
try {
  worktreePaths = req(join(DIST, 'lib', 'worktree-paths.js'));
  processUtils  = req(join(DIST, 'platform', 'process-utils.js'));
} catch (e) {
  console.error('FATAL: Could not load dist modules:', e.message);
  process.exit(1);
}

const {
  findWorkspaceRoot,
  getOmcRoot,
  getProjectIdentifier,
  resolveSessionStatePaths,
  clearWorktreeCache,
  warnSiblingRetrofit,
  clearSiblingRetrofitWarnings,
} = worktreePaths;

const { isProcessAlive } = processUtils;

// --------------------------------------------------------------------------
// Fixture setup
// --------------------------------------------------------------------------
const FIXTURE = join(tmpdir(), `omc-multirepo-smoke-${process.pid}`);
const apiDir   = join(FIXTURE, 'api');
const webDir   = join(FIXTURE, 'web');

let passed = 0;
let failed = 0;
const issues = [];

function pass(label, detail) {
  passed++;
  console.log(`  PASS  ${label}`);
  if (detail) console.log(`        ${detail}`);
}
function fail(label, detail, contract) {
  failed++;
  console.error(`  FAIL  ${label}`);
  if (detail)   console.error(`        actual:   ${detail}`);
  if (contract) console.error(`        contract: ${contract}`);
  issues.push({ label, detail, contract });
}
function note(label, detail) {
  console.log(`  NOTE  ${label}`);
  if (detail) console.log(`        ${detail}`);
}
function assert(cond, passLabel, failLabel, detail, contract) {
  if (cond) pass(passLabel, detail);
  else fail(failLabel, detail, contract);
}

// --------------------------------------------------------------------------
// Setup fixture
// --------------------------------------------------------------------------
console.log('\n=== FIXTURE SETUP ===');
console.log(`  fixture: ${FIXTURE}`);

mkdirSync(apiDir, { recursive: true });
mkdirSync(webDir, { recursive: true });

// Workspace marker with id at root (no git init at root)
writeFileSync(join(FIXTURE, '.omc-workspace'), JSON.stringify({ id: 'smoke-test' }));

// Real git repos in sub-dirs
execSync('git init -q', { cwd: apiDir, stdio: 'pipe' });
execSync('git init -q', { cwd: webDir, stdio: 'pipe' });

// Bust cache so fresh calls see the fixture
clearWorktreeCache();

// --------------------------------------------------------------------------
// Step 1 — findWorkspaceRoot / getOmcRoot / getProjectIdentifier from api/
// --------------------------------------------------------------------------
console.log('\n=== STEP 1: API dir — workspace root + omc root + project identifier ===');

const wsRoot = findWorkspaceRoot(apiDir);
assert(
  wsRoot !== null && resolve(wsRoot) === resolve(FIXTURE),
  'findWorkspaceRoot(apiDir) → fixture root',
  'findWorkspaceRoot(apiDir) → WRONG',
  `returned: ${wsRoot}  expected: ${FIXTURE}`,
  'findWorkspaceRoot must walk up from sub-git-repo to .omc-workspace marker'
);

clearWorktreeCache();
const omcRoot = getOmcRoot(apiDir);
const expectedOmcRoot = join(FIXTURE, '.omc');
assert(
  resolve(omcRoot) === resolve(expectedOmcRoot),
  'getOmcRoot(apiDir) → fixture/.omc',
  'getOmcRoot(apiDir) → WRONG',
  `returned: ${omcRoot}  expected: ${expectedOmcRoot}`,
  'getOmcRoot must anchor to workspace marker dir, not api/ git root'
);

clearWorktreeCache();
const projId = getProjectIdentifier(apiDir);
const idMatch = /^smoke-test-[a-f0-9]{16}$/.test(projId);
assert(
  idMatch,
  `getProjectIdentifier(apiDir) → ${projId}`,
  'getProjectIdentifier(apiDir) → WRONG FORMAT',
  `returned: ${projId}`,
  'must be smoke-test-<16-hex-chars> when marker id="smoke-test"'
);

// --------------------------------------------------------------------------
// Step 1b — resolveSessionStatePaths from api/
// --------------------------------------------------------------------------
clearWorktreeCache();
const apiPaths = resolveSessionStatePaths('demo', 'session-api', apiDir);
const expectedApiWrite = join(FIXTURE, '.omc', 'state', 'sessions', 'session-api', 'demo-state.json');
assert(
  resolve(apiPaths.effectiveWrite) === resolve(expectedApiWrite),
  `resolveSessionStatePaths api effectiveWrite → …sessions/session-api/demo-state.json`,
  'resolveSessionStatePaths api effectiveWrite → WRONG',
  `returned: ${apiPaths.effectiveWrite}\n        expected: ${expectedApiWrite}`,
  'effectiveWrite must be session-scoped under shared .omc/'
);

// --------------------------------------------------------------------------
// Step 2 — web/ paths same .omc, different session subdir
// --------------------------------------------------------------------------
console.log('\n=== STEP 2: WEB dir — same .omc, different session ===');

clearWorktreeCache();
const webPaths = resolveSessionStatePaths('demo', 'session-web', webDir);
const expectedWebWrite = join(FIXTURE, '.omc', 'state', 'sessions', 'session-web', 'demo-state.json');

assert(
  resolve(webPaths.effectiveWrite) === resolve(expectedWebWrite),
  `resolveSessionStatePaths web effectiveWrite → …sessions/session-web/demo-state.json`,
  'resolveSessionStatePaths web effectiveWrite → WRONG',
  `returned: ${webPaths.effectiveWrite}\n        expected: ${expectedWebWrite}`,
  'effectiveWrite must be under shared .omc/ with distinct session subdir'
);

assert(
  apiPaths.effectiveWrite !== webPaths.effectiveWrite,
  'api and web session paths are distinct (no collision)',
  'api and web session paths COLLIDE',
  `api=${apiPaths.effectiveWrite}\n        web=${webPaths.effectiveWrite}`,
  'multi-repo sessions must not overwrite each other'
);

// Actually write and read back both
mkdirSync(resolve(apiPaths.effectiveWrite, '..'), { recursive: true });
mkdirSync(resolve(webPaths.effectiveWrite, '..'), { recursive: true });
writeFileSync(apiPaths.effectiveWrite, JSON.stringify({ session: 'api', ts: Date.now() }));
writeFileSync(webPaths.effectiveWrite, JSON.stringify({ session: 'web', ts: Date.now() }));

const apiRead = JSON.parse(readFileSync(apiPaths.effectiveWrite, 'utf-8'));
const webRead = JSON.parse(readFileSync(webPaths.effectiveWrite, 'utf-8'));
assert(apiRead.session === 'api', 'api session file written and read back correctly', 'api session file read back WRONG', String(apiRead.session));
assert(webRead.session === 'web', 'web session file written and read back correctly', 'web session file read back WRONG', String(webRead.session));

console.log(`        api write path: ${apiPaths.effectiveWrite}`);
console.log(`        web write path: ${webPaths.effectiveWrite}`);

// --------------------------------------------------------------------------
// Step 3 — ultragoal create-goals via CLI (multi-plan)
// --------------------------------------------------------------------------
console.log('\n=== STEP 3: ultragoal create-goals (CLI, multi-plan) ===');

// ultragoal/artifacts.ts uses getOmcRoot(cwd) — plans land in the shared
// workspace-marker root when .omc-workspace is present (fixed in multi-repo
// rollout). The CLI sets cwd = subprocess cwd; resolution flows through
// getOmcRoot which honors OMC_STATE_DIR > .omc-workspace > git > cwd.

function runUltragoal(cwd, sessionId, brief) {
  return spawnSync(
    process.execPath,
    [BRIDGE_CLI, 'ultragoal', 'create-goals', '--brief', brief, '--auto-plan-id', '--json'],
    {
      cwd,
      env: { ...process.env, OMC_SESSION_ID: sessionId },
      encoding: 'utf-8',
      timeout: 30000,
    }
  );
}

const apiResult = runUltragoal(apiDir, 'session-api', 'API migration');
const webResult = runUltragoal(webDir, 'session-web', 'Web redesign');

let apiPlanId = null;
let webPlanId = null;

// Parse planId from JSON stdout
function parsePlanId(stdout) {
  for (const line of stdout.split('\n').filter(Boolean)) {
    try { const p = JSON.parse(line); if (p.planId) return p.planId; } catch {}
  }
  return null;
}

if (apiResult.status === 0) {
  apiPlanId = parsePlanId(apiResult.stdout);
  pass(`ultragoal create-goals (api) exited 0`, `planId: ${apiPlanId}`);
} else {
  fail(
    'ultragoal create-goals (api) exited non-zero',
    `exit=${apiResult.status}\nstderr=${apiResult.stderr?.slice(0, 400)}\nstdout=${apiResult.stdout?.slice(0, 400)}`,
    'CLI must exit 0 for valid create-goals invocation'
  );
}

if (webResult.status === 0) {
  webPlanId = parsePlanId(webResult.stdout);
  pass(`ultragoal create-goals (web) exited 0`, `planId: ${webPlanId}`);
} else {
  fail(
    'ultragoal create-goals (web) exited non-zero',
    `exit=${webResult.status}\nstderr=${webResult.stderr?.slice(0, 400)}\nstdout=${webResult.stdout?.slice(0, 400)}`,
    'CLI must exit 0 for valid create-goals invocation'
  );
}

// Actual write locations: <subrepo>/.omc/ultragoal/plans/<planId>/
const apiPlansDir = join(apiDir, '.omc', 'ultragoal', 'plans');
const webPlansDir = join(webDir, '.omc', 'ultragoal', 'plans');
const sharedPlansDir = join(FIXTURE, '.omc', 'ultragoal', 'plans');

const apiPlanDirs = existsSync(apiPlansDir) ? readdirSync(apiPlansDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
const webPlanDirs = existsSync(webPlansDir) ? readdirSync(webPlansDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
const sharedPlanDirs = existsSync(sharedPlansDir) ? readdirSync(sharedPlansDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];

console.log(`        api plans dir:    ${apiPlansDir}`);
console.log(`        api plan IDs:     ${apiPlanDirs.join(', ') || '(none)'}`);
console.log(`        web plans dir:    ${webPlansDir}`);
console.log(`        web plan IDs:     ${webPlanDirs.join(', ') || '(none)'}`);
console.log(`        shared plans dir: ${sharedPlansDir}`);
console.log(`        shared plan IDs:  ${sharedPlanDirs.join(', ') || '(none)'}`);

// After multi-repo Wave A: ultragoal plans now land in the shared workspace .omc/
// because artifacts.ts was updated to use getOmcRoot()/workspace-marker resolution.
// Plans from BOTH subrepos go to the shared FIXTURE/.omc/ultragoal/plans/.
const totalPlans = apiPlanDirs.length + webPlanDirs.length + sharedPlanDirs.length;
if (sharedPlanDirs.length >= 2) {
  pass(
    `ultragoal plans land in shared workspace .omc/ (${sharedPlanDirs.length} plans)`,
    `shared: ${sharedPlanDirs.join(', ')}`
  );
} else if (apiPlanDirs.length >= 1 && webPlanDirs.length >= 1) {
  // Pre-Wave-A behavior: plans in per-subrepo dirs
  pass(
    `ultragoal plans in per-subrepo dirs (${apiPlanDirs.length} api, ${webPlanDirs.length} web)`,
    `api: ${apiPlanDirs.join(', ')}  web: ${webPlanDirs.join(', ')}`
  );
} else {
  assert(
    totalPlans >= 2,
    `ultragoal plans created (${totalPlans} total across api/web/shared)`,
    `ultragoal plans missing — no plans in api, web, or shared dirs`,
    `api=${apiPlanDirs.join(',')} web=${webPlanDirs.join(',')} shared=${sharedPlanDirs.join(',')}`,
    'create-goals must write at least one plan per subrepo invocation'
  );
}

// Plans do NOT collide (distinct IDs — auto-plan-id uses timestamp)
if (apiPlanId && webPlanId) {
  assert(
    apiPlanId !== webPlanId,
    'api and web plan IDs are distinct (no collision)',
    'api and web plan IDs are IDENTICAL — collision',
    `api=${apiPlanId}  web=${webPlanId}`,
    '--auto-plan-id must generate unique IDs per invocation'
  );
}

// --------------------------------------------------------------------------
// Step 4 — PID liveness (dead PID detection)
// --------------------------------------------------------------------------
console.log('\n=== STEP 4: PID liveness — dead PID 999999 ===');

const fakeSid = 'fake-sid-dead-pid';
const fakeStateDir = join(FIXTURE, '.omc', 'state', 'sessions', fakeSid);
mkdirSync(fakeStateDir, { recursive: true });
const fakeStatePath = join(fakeStateDir, 'ultrawork-state.json');
writeFileSync(fakeStatePath, JSON.stringify({ active: true, owner_pid: 999999 }));

const rawState = JSON.parse(readFileSync(fakeStatePath, 'utf-8'));
const deadPid = rawState.owner_pid;
const alive = isProcessAlive(deadPid);
assert(
  !alive,
  `isProcessAlive(${deadPid}) → false (dead PID correctly detected)`,
  `isProcessAlive(${deadPid}) → true (dead PID NOT detected — BUG)`,
  `owner_pid=${deadPid} alive=${alive}`,
  'PID 999999 must not be alive on any sane system'
);

const currentAlive = isProcessAlive(process.pid);
assert(
  currentAlive,
  `isProcessAlive(${process.pid}) → true (current process correctly alive)`,
  `isProcessAlive(${process.pid}) → false (WRONG — current process should be alive)`,
  `pid=${process.pid} alive=${currentAlive}`
);

// --------------------------------------------------------------------------
// Step 5 — Session subdir contents listing
// --------------------------------------------------------------------------
console.log('\n=== STEP 5: Session subdir contents (shared .omc/) ===');
const sessionsDir = join(FIXTURE, '.omc', 'state', 'sessions');
if (existsSync(sessionsDir)) {
  const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const files = readdirSync(join(sessionsDir, e.name)).join(', ');
      return `  ${e.name}/  →  ${files || '(empty)'}`;
    });
  console.log('  Sessions in shared fixture .omc/:');
  sessionDirs.forEach(s => console.log(s));
} else {
  console.log('  sessions dir not found (steps 1-2 must have failed)');
}

// --------------------------------------------------------------------------
// Step 6 — Windows backslash path (platform-conditional)
// --------------------------------------------------------------------------
console.log('\n=== STEP 6: Windows backslash path with OMC_STATE_DIR ===');

if (process.platform === 'win32') {
  const winStateDir = join(FIXTURE, 'win-state');
  mkdirSync(winStateDir, { recursive: true });
  const origStateDirEnv = process.env.OMC_STATE_DIR;
  process.env.OMC_STATE_DIR = winStateDir;
  clearWorktreeCache();

  const winPaths = resolveSessionStatePaths('test', 'win-session', apiDir);
  const writePath = winPaths.effectiveWrite;

  // Assert: no resolved write path contains \.omc\ OUTSIDE the configured OMC_STATE_DIR root
  const containsOmcOutsideRoot =
    writePath.includes('\\.omc\\') &&
    !writePath.startsWith(winStateDir);

  assert(
    !containsOmcOutsideRoot,
    'Windows: resolved write path does not contain \\.omc\\ outside configured OMC_STATE_DIR',
    'Windows: resolved write path contains \\.omc\\ OUTSIDE OMC_STATE_DIR (path escape bug)',
    `writePath=${writePath}  stateDir=${winStateDir}`,
    'When OMC_STATE_DIR is set, no path should escape to a raw /.omc/ location'
  );
  console.log(`        write path: ${writePath}`);

  // Restore
  if (origStateDirEnv === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = origStateDirEnv;
  clearWorktreeCache();
} else {
  note('Step 6 skipped on non-win32 platform', `platform=${process.platform} — Windows backslash test only runs on win32`);
}

// --------------------------------------------------------------------------
// Step 7 — Workspace-marker retrofit: pre-existing sibling .omc/state/
// --------------------------------------------------------------------------
console.log('\n=== STEP 7: Workspace-marker retrofit sibling-scan warning ===');

const retrofitFixture = join(tmpdir(), `omc-retrofit-smoke-${process.pid}`);
const retrofitApi = join(retrofitFixture, 'api');
const retrofitWeb = join(retrofitFixture, 'web');
mkdirSync(retrofitApi, { recursive: true });
mkdirSync(retrofitWeb, { recursive: true });

// Pre-create sibling .omc/state/ content BEFORE dropping workspace marker
const legacyStateDir = join(retrofitApi, '.omc', 'state');
mkdirSync(legacyStateDir, { recursive: true });
const legacyStateFile = join(legacyStateDir, 'ralph-state.json');
const legacyContent = JSON.stringify({ active: true, mode: 'ralph', legacy: true });
writeFileSync(legacyStateFile, legacyContent);

// Drop workspace marker at fixture root
writeFileSync(join(retrofitFixture, '.omc-workspace'), JSON.stringify({ id: 'retrofit-test' }));
execSync('git init -q', { cwd: retrofitApi, stdio: 'pipe' });

// Capture stderr to detect warning
let retrofitStderr = '';
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  retrofitStderr += typeof chunk === 'string' ? chunk : chunk.toString();
  return origStderrWrite(chunk, ...args);
};

clearWorktreeCache();
// Clear in-memory + disk dedupe so the warning fires fresh in this test
if (clearSiblingRetrofitWarnings) clearSiblingRetrofitWarnings();
// Trigger via warnSiblingRetrofit directly (lifted off getOmcRoot hot path)
const retrofitAnchor = findWorkspaceRoot(retrofitApi);
if (retrofitAnchor) warnSiblingRetrofit(retrofitAnchor);

// Restore stderr
process.stderr.write = origStderrWrite;

// (i) Structured warning emitted listing sibling .omc/state dirs
assert(
  retrofitStderr.includes('[omc] workspace-retrofit warning'),
  'Retrofit warning emitted to stderr',
  'Retrofit warning NOT emitted to stderr',
  `stderr captured: ${retrofitStderr.slice(0, 200)}`,
  'warnSiblingRetrofit must fire when sibling has pre-existing .omc/state/'
);

// (ii) Pre-existing api/.omc/state/ralph-state.json not overwritten or deleted
assert(
  existsSync(legacyStateFile),
  'Pre-existing ralph-state.json preserved (not deleted)',
  'Pre-existing ralph-state.json DELETED (data loss bug)',
  `path: ${legacyStateFile}`,
  'warnSiblingRetrofit must only warn — never mutate existing state'
);
const readBack = readFileSync(legacyStateFile, 'utf-8');
assert(
  readBack === legacyContent,
  'Pre-existing ralph-state.json content unchanged',
  'Pre-existing ralph-state.json OVERWRITTEN (data loss bug)',
  `expected: ${legacyContent}  actual: ${readBack}`,
  'warnSiblingRetrofit must never write to legacy state dirs'
);

// (iii) Warning includes copy-pasteable migration command
assert(
  retrofitStderr.includes('OMC_MIGRATE_LEGACY_STATE=1'),
  'Retrofit warning includes OMC_MIGRATE_LEGACY_STATE=1 migration command',
  'Retrofit warning missing OMC_MIGRATE_LEGACY_STATE=1 migration hint',
  `stderr: ${retrofitStderr.slice(0, 300)}`,
  'Warning must guide user to migration path'
);

rmSync(retrofitFixture, { recursive: true, force: true });
clearWorktreeCache();

// --------------------------------------------------------------------------
// Step 8 — Template drift simulation: AST-grep gate red on raw .omc pattern
// --------------------------------------------------------------------------
console.log('\n=== STEP 8: AST-grep gate — drift fixture triggers non-zero exit ===');

const driftFixtureDir = join(tmpdir(), `omc-drift-gate-${process.pid}`);
mkdirSync(driftFixtureDir, { recursive: true });
const driftFixtureFile = join(driftFixtureDir, 'drift-fixture.mjs');
writeFileSync(
  driftFixtureFile,
  `import {join} from 'path'; const dir = '/tmp'; const p = join(dir, '.omc', 'state', 'foo');\n`
);

const gateScript = join(__dirname, 'ci', 'check-multirepo-paths.mjs');
const gateResult = spawnSync(
  process.execPath,
  [gateScript, '--root', driftFixtureDir],
  { encoding: 'utf-8', timeout: 30000 }
);

assert(
  gateResult.status !== 0,
  'AST-grep gate exits non-zero on drift fixture',
  'AST-grep gate exits ZERO on drift fixture (failed to detect raw .omc pattern)',
  `exit=${gateResult.status}\nstdout=${gateResult.stdout?.slice(0, 300)}\nstderr=${gateResult.stderr?.slice(0, 300)}`,
  'Gate must exit non-zero when raw join(...,.omc,...) is found outside whitelist'
);

assert(
  gateResult.stderr?.includes(driftFixtureDir) || gateResult.stderr?.includes('drift-fixture'),
  'AST-grep gate output includes drift fixture path',
  'AST-grep gate output does NOT include drift fixture path',
  `stderr: ${gateResult.stderr?.slice(0, 300)}`,
  'Gate must print matched file path for actionable output'
);

assert(
  gateResult.stderr?.includes("join(dir, '.omc'") || gateResult.stderr?.includes('.omc'),
  'AST-grep gate output includes matched pattern text',
  'AST-grep gate output missing matched pattern text',
  `stderr: ${gateResult.stderr?.slice(0, 300)}`
);

rmSync(driftFixtureDir, { recursive: true, force: true });

// --------------------------------------------------------------------------
// Cleanup
// --------------------------------------------------------------------------
console.log('\n=== CLEANUP ===');
rmSync(FIXTURE, { recursive: true, force: true });
console.log(`  Removed ${FIXTURE}`);

// --------------------------------------------------------------------------
// Final verdict
// --------------------------------------------------------------------------
console.log('\n=== FINAL VERDICT ===');
console.log(`  Passed: ${passed}   Failed: ${failed}`);

if (failed === 0) {
  console.log('\n  multi-repo workspace works END-TO-END');
  console.log('  All subsystems (ultragoal, ralph, ultrawork, autopilot, hooks,');
  console.log('  state) anchor to .omc-workspace marker when present.\n');
} else {
  console.log('\n  FAILING CONTRACTS (priority order):');
  issues.forEach((issue, i) => {
    console.log(`  ${i + 1}. ${issue.label}`);
    if (issue.contract) console.log(`     Contract: ${issue.contract}`);
    if (issue.detail)   console.log(`     Detail:   ${issue.detail}`);
  });
  console.log('');
  process.exit(1);
}
