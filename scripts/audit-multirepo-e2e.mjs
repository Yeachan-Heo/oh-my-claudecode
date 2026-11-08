#!/usr/bin/env node
/**
 * Audit B — End-to-end multi-repo fixture
 *
 * Creates a fresh workspace in os.tmpdir() with .omc-workspace + sibling sub-repos.
 * Exercises 15 assertions across 11 subsystems + retrofit + rollback scenarios.
 *
 * Usage (from repo root):
 *   node scripts/audit-multirepo-e2e.mjs
 *   CLAUDE_PLUGIN_ROOT=/other/path node scripts/audit-multirepo-e2e.mjs
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT   = resolve(__filename, '..', '..');
// Always use the local repo's dist, not the globally installed package.
// CLAUDE_PLUGIN_ROOT may point to the npm-installed version which predates
// the multi-repo changes under test.
const PLUGIN_ROOT = REPO_ROOT;
const DIST_WP     = join(PLUGIN_ROOT, 'dist', 'lib', 'worktree-paths.js');
const DIST_UG     = join(PLUGIN_ROOT, 'dist', 'ultragoal', 'artifacts.js');
const DIST_INT    = join(PLUGIN_ROOT, 'dist', 'interop', 'shared-state.js');
const SI_SCRIPT   = join(PLUGIN_ROOT, 'skills', 'self-improve', 'scripts', 'resolve-paths.mjs');

// ── Result helpers ─────────────────────────────────────────────────────────────

function pass(n, msg) {
  console.log(`  [${String(n).padStart(2)}] PASS  ${msg}`);
  return { n, status: 'PASS', msg };
}

function fail(n, msg, expected, observed) {
  console.log(`  [${String(n).padStart(2)}] FAIL  ${msg}`);
  if (expected !== undefined) console.log(`          expected: ${expected}`);
  if (observed !== undefined) console.log(`          observed: ${observed}`);
  return { n, status: 'FAIL', msg, expected, observed };
}

// ── Subprocess probe via temp .mjs file ───────────────────────────────────────
// Each probe is written to a real temp file so import.meta.url is a valid path
// and dynamic import() of ES module dist files works correctly.
//
// All probes share a preamble that imports worktree-paths and binds helpers to
// globals. Body scripts use those globals directly without re-importing.

const PROBE_PREAMBLE = `
import { pathToFileURL } from 'url';
import { join as _pjoin } from 'path';
const _wp = await import(pathToFileURL(${JSON.stringify(DIST_WP)}).href);
const { clearWorktreeCache, clearSiblingRetrofitWarnings, getOmcRoot,
        resolveSessionStatePaths, getWorktreeNotepadPath,
        getWorktreeProjectMemoryPath, findWorkspaceRoot, warnSiblingRetrofit } = _wp;
clearWorktreeCache();
clearSiblingRetrofitWarnings?.();
`;

let _probeDir = null;
function getProbeDir() {
  if (!_probeDir) {
    // Use C:\Temp (outside homedir) so findWorkspaceRoot walk is not cut off
    // by the homedir guard that stops at C:\Users\<user>.
    try {
      mkdirSync('C:\\Temp', { recursive: true });
      _probeDir = mkdtempSync('C:\\Temp\\omc-probe-');
    } catch {
      _probeDir = mkdtempSync(join(tmpdir(), 'omc-probe-'));
    }
  }
  return _probeDir;
}

let _probeCounter = 0;
function probe(scriptBody, extraEnv = {}) {
  const dir = getProbeDir();
  const file = join(dir, `probe-${++_probeCounter}.mjs`);
  writeFileSync(file, PROBE_PREAMBLE + '\n' + scriptBody);
  // Explicitly set CLAUDE_PLUGIN_ROOT to REPO_ROOT so subprocess probes load
  // the local dist, not the globally installed npm package.
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...extraEnv };
  delete env.CLAUDE_PLUGIN_ROOT; // remove first to avoid stale value
  env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;
  const sp = spawnSync(process.execPath, [file], {
    encoding: 'utf-8',
    timeout: 20000,
    env,
  });
  return { stdout: sp.stdout ?? '', stderr: sp.stderr ?? '', status: sp.status ?? -1 };
}

function probeJSON(scriptBody, extraEnv = {}) {
  const r = probe(scriptBody, extraEnv);
  if (r.status !== 0) return { ok: false, error: `exit ${r.status}: ${r.stderr.slice(0, 400)}` };
  try {
    return { ok: true, data: JSON.parse(r.stdout.trim()), stderr: r.stderr };
  } catch (e) {
    return { ok: false, error: `JSON parse: ${e.message} — stdout: ${r.stdout.slice(0, 200)}` };
  }
}

// ── Fixture helpers ────────────────────────────────────────────────────────────

function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), `# ${dir}\n`);
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  try {
    execSync('git -c user.email=t@t.com -c user.name=T commit -q -m init', { cwd: dir, stdio: 'pipe' });
  } catch { /* CI may lack git identity */ }
}

function buildFixture() {
  // Use C:\Temp (outside homedir) so findWorkspaceRoot walk is not blocked by
  // the homedir guard in worktree-paths.ts (Windows: %TEMP% == C:\Users\<u>\AppData\Local\Temp).
  let base;
  try {
    mkdirSync('C:\\Temp', { recursive: true });
    base = mkdtempSync('C:\\Temp\\omc-audit-');
  } catch {
    base = mkdtempSync(join(tmpdir(), 'omc-audit-'));
  }
  console.log(`\n  Fixture root: ${base}\n`);
  writeFileSync(join(base, '.omc-workspace'), JSON.stringify({ id: 'audit' }));
  for (const name of ['api', 'web', 'worker']) {
    gitInit(join(base, name));
  }
  return base;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Audit B: End-to-end multi-repo fixture ===\n');

  if (!existsSync(DIST_WP)) {
    console.error(`ERROR: dist not built — expected ${DIST_WP}`);
    process.exit(1);
  }

  const results = [];
  const base = buildFixture();
  const ws_omc = join(base, '.omc');
  const sid = 'audit-session-1';

  // ── 1. ultragoal — ultragoalDir(cwd, planId) ──────────────────────────────
  {
    const r = probeJSON(`
const { ultragoalDir } = await import(pathToFileURL(${JSON.stringify(DIST_UG)}).href);
const dir = ultragoalDir(${JSON.stringify(join(base, 'api'))});
process.stdout.write(JSON.stringify({ dir }) + '\\n');
`);
    if (!r.ok) {
      results.push(fail(1, `ultragoal probe error: ${r.error}`));
    } else {
      const expected = join(ws_omc, 'ultragoal');
      results.push(r.data.dir === expected
        ? pass(1, `ultragoal dir → workspace .omc/ultragoal`)
        : fail(1, 'ultragoalDir should resolve under workspace .omc', expected, r.data.dir));
    }
  }

  // ── 2. ralph ──────────────────────────────────────────────────────────────
  {
    const r = probeJSON(`
const p = resolveSessionStatePaths('ralph', ${JSON.stringify(sid)}, ${JSON.stringify(join(base, 'api'))});
process.stdout.write(JSON.stringify({ write: p.effectiveWrite }) + '\\n');
`);
    if (!r.ok) results.push(fail(2, `ralph probe error: ${r.error}`));
    else results.push(r.data.write.startsWith(ws_omc)
      ? pass(2, `ralph effectiveWrite → workspace .omc`)
      : fail(2, 'ralph path should be under workspace .omc', ws_omc + '/...', r.data.write));
  }

  // ── 3. ultrawork ─────────────────────────────────────────────────────────
  {
    const r = probeJSON(`
const p = resolveSessionStatePaths('ultrawork', ${JSON.stringify(sid)}, ${JSON.stringify(join(base, 'web'))});
process.stdout.write(JSON.stringify({ write: p.effectiveWrite }) + '\\n');
`);
    if (!r.ok) results.push(fail(3, `ultrawork probe error: ${r.error}`));
    else results.push(r.data.write.startsWith(ws_omc)
      ? pass(3, `ultrawork effectiveWrite → workspace .omc`)
      : fail(3, 'ultrawork path should be under workspace .omc', ws_omc + '/...', r.data.write));
  }

  // ── 4. autopilot ─────────────────────────────────────────────────────────
  {
    const r = probeJSON(`
const p = resolveSessionStatePaths('autopilot', ${JSON.stringify(sid)}, ${JSON.stringify(join(base, 'worker'))});
process.stdout.write(JSON.stringify({ write: p.effectiveWrite }) + '\\n');
`);
    if (!r.ok) results.push(fail(4, `autopilot probe error: ${r.error}`));
    else results.push(r.data.write.startsWith(ws_omc)
      ? pass(4, `autopilot effectiveWrite → workspace .omc`)
      : fail(4, 'autopilot path should be under workspace .omc', ws_omc + '/...', r.data.write));
  }

  // ── 5. team (resolveSessionStatePaths + getOmcRoot) ──────────────────────
  {
    const r = probeJSON(`
const p    = resolveSessionStatePaths('team', ${JSON.stringify(sid)}, ${JSON.stringify(join(base, 'api'))});
const root = getOmcRoot(${JSON.stringify(join(base, 'api'))});
process.stdout.write(JSON.stringify({ write: p.effectiveWrite, root }) + '\\n');
`);
    if (!r.ok) results.push(fail(5, `team probe error: ${r.error}`));
    else {
      const { write, root } = r.data;
      results.push(write.startsWith(ws_omc) && root === ws_omc
        ? pass(5, `team effectiveWrite + getOmcRoot → workspace .omc`)
        : fail(5, 'team path or getOmcRoot should be workspace .omc', ws_omc,
            `write=${write}  root=${root}`));
    }
  }

  // ── 6. ralplan ───────────────────────────────────────────────────────────
  {
    const r = probeJSON(`
const p = resolveSessionStatePaths('ralplan', ${JSON.stringify(sid)}, ${JSON.stringify(join(base, 'web'))});
process.stdout.write(JSON.stringify({ write: p.effectiveWrite }) + '\\n');
`);
    if (!r.ok) results.push(fail(6, `ralplan probe error: ${r.error}`));
    else results.push(r.data.write.startsWith(ws_omc)
      ? pass(6, `ralplan effectiveWrite → workspace .omc`)
      : fail(6, 'ralplan path should be under workspace .omc', ws_omc + '/...', r.data.write));
  }

  // ── 7. self-improve (resolve-paths.mjs subprocess) ───────────────────────
  {
    if (!existsSync(SI_SCRIPT)) {
      results.push(fail(7, 'skills/self-improve/scripts/resolve-paths.mjs not found', SI_SCRIPT, 'missing'));
    } else {
      const sp = spawnSync(
        process.execPath,
        [SI_SCRIPT, '--project-root', join(base, 'api'), '--format', 'json'],
        { encoding: 'utf-8', timeout: 15000,
          env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } }
      );
      const stdout = sp.stdout ?? '';
      if (sp.status !== 0) {
        results.push(fail(7, `resolve-paths.mjs exited ${sp.status}: ${(sp.stderr ?? '').slice(0, 200)}`));
      } else if (!stdout.trim()) {
        // Windows bug: import.meta.url is 'file:///C:/...' but process.argv[1] is 'C:\...'
        // so the `if (import.meta.url === \`file://\${process.argv[1]}\`)` guard never fires
        // and main() is never called. Script exits 0 with empty output.
        results.push(fail(7,
          'self-improve resolve-paths.mjs produces no output on Windows — entrypoint guard ' +
          '`import.meta.url === \\`file://${process.argv[1]}\\`` never matches because ' +
          'import.meta.url uses file:///C:/... but argv[1] uses C:\\... (backslash, no triple-slash)',
          join(ws_omc, 'self-improve') + ' in base_root',
          'empty stdout (exit 0) — main() not called'));
      } else {
        try {
          const parsed = JSON.parse(stdout);
          results.push(parsed.base_root?.startsWith(ws_omc)
            ? pass(7, `self-improve base_root → workspace .omc/self-improve`)
            : fail(7, 'self-improve base_root should be under workspace .omc',
                join(ws_omc, 'self-improve'), parsed.base_root));
        } catch (e) {
          results.push(fail(7, `self-improve JSON parse error: ${e.message}`, '', stdout.slice(0, 200)));
        }
      }
    }
  }

  // ── 8. interop (getInteropDir) ────────────────────────────────────────────
  {
    const r = probeJSON(`
const { getInteropDir } = await import(pathToFileURL(${JSON.stringify(DIST_INT)}).href);
const dir = getInteropDir(${JSON.stringify(join(base, 'api'))});
process.stdout.write(JSON.stringify({ dir }) + '\\n');
`);
    if (!r.ok) results.push(fail(8, `interop probe error: ${r.error}`));
    else {
      const expected = join(ws_omc, 'state', 'interop');
      results.push(r.data.dir === expected
        ? pass(8, `interop dir → workspace .omc/state/interop`)
        : fail(8, 'interop dir should be workspace .omc/state/interop', expected, r.data.dir));
    }
  }

  // ── 9. autoresearch (getOmcRoot → specs path) ────────────────────────────
  {
    const r = probeJSON(`
const root = getOmcRoot(${JSON.stringify(join(base, 'worker'))});
const specsPath = _pjoin(root, 'specs');
process.stdout.write(JSON.stringify({ root, specsPath }) + '\\n');
`);
    if (!r.ok) results.push(fail(9, `autoresearch probe error: ${r.error}`));
    else results.push(r.data.root.startsWith(ws_omc)
      ? pass(9, `autoresearch specs path → workspace .omc/specs`)
      : fail(9, 'autoresearch specs should be under workspace .omc',
          join(ws_omc, 'specs'), r.data.specsPath));
  }

  // ── 10. notepad + project-memory ─────────────────────────────────────────
  {
    const r = probeJSON(`
const notepadPath = getWorktreeNotepadPath(${JSON.stringify(join(base, 'api'))});
const memoryPath  = getWorktreeProjectMemoryPath(${JSON.stringify(join(base, 'web'))});
process.stdout.write(JSON.stringify({ notepadPath, memoryPath }) + '\\n');
`);
    if (!r.ok) results.push(fail(10, `notepad/memory probe error: ${r.error}`));
    else {
      const { notepadPath, memoryPath } = r.data;
      const expN = join(ws_omc, 'notepad.md');
      const expM = join(ws_omc, 'project-memory.json');
      results.push(notepadPath === expN && memoryPath === expM
        ? pass(10, `notepad + project-memory → workspace .omc`)
        : fail(10, 'notepad/memory paths should be workspace .omc',
            `${expN}  |  ${expM}`, `${notepadPath}  |  ${memoryPath}`));
    }
  }

  // ── Retrofit scenario (items 11–14) ───────────────────────────────────────

  let retrofitBase;
  try {
    mkdirSync('C:\\Temp', { recursive: true });
    retrofitBase = mkdtempSync('C:\\Temp\\omc-audit-retrofit-');
  } catch {
    retrofitBase = mkdtempSync(join(tmpdir(), 'omc-audit-retrofit-'));
  }
  gitInit(join(retrofitBase, 'api'));
  const legacyStateDir  = join(retrofitBase, 'api', '.omc', 'state');
  const legacyStateFile = join(legacyStateDir, 'ralph-state.json');
  mkdirSync(legacyStateDir, { recursive: true });
  writeFileSync(legacyStateFile, JSON.stringify({ iteration: 3 }));

  // 11. legacy state exists BEFORE marker drop
  results.push(existsSync(legacyStateFile)
    ? pass(11, `legacy api/.omc/state/ralph-state.json created before .omc-workspace drop`)
    : fail(11, 'legacy state file should exist before workspace marker drop', legacyStateFile, 'missing'));

  // 12. drop .omc-workspace marker
  writeFileSync(join(retrofitBase, '.omc-workspace'), JSON.stringify({ id: 'retrofit-test' }));
  results.push(existsSync(join(retrofitBase, '.omc-workspace'))
    ? pass(12, `.omc-workspace marker dropped at parent after legacy state exists`)
    : fail(12, '.omc-workspace marker should exist after write'));

  // 13. warnSiblingRetrofit fires once with path + OMC_MIGRATE_LEGACY_STATE hint
  {
    const r = probe(`
const root = getOmcRoot(${JSON.stringify(join(retrofitBase, 'api'))});
const anchor = findWorkspaceRoot(${JSON.stringify(join(retrofitBase, 'api'))});
if (anchor) warnSiblingRetrofit(anchor, 'test-session-13');
process.stdout.write(JSON.stringify({ root }) + '\\n');
`);
    const stderr = r.stderr ?? '';
    const hasWarning     = stderr.includes('workspace-retrofit warning');
    const hasLegacyPath  = stderr.includes(join(retrofitBase, 'api', '.omc'));
    const hasMigrateHint = stderr.includes('OMC_MIGRATE_LEGACY_STATE');
    results.push(hasWarning && hasLegacyPath && hasMigrateHint
      ? pass(13, `warnSiblingRetrofit fires with legacy path + OMC_MIGRATE_LEGACY_STATE hint`)
      : fail(13,
          'warnSiblingRetrofit should emit warning with legacy .omc path and OMC_MIGRATE_LEGACY_STATE=1 hint',
          'stderr: workspace-retrofit warning + api/.omc path + OMC_MIGRATE_LEGACY_STATE',
          `hasWarning=${hasWarning} hasPath=${hasLegacyPath} hasHint=${hasMigrateHint}\n` +
          `stderr=${stderr.slice(0, 600)}`));
  }

  // 14. legacy file UNCHANGED after retrofit (no auto-migration)
  {
    if (!existsSync(legacyStateFile)) {
      results.push(fail(14, 'legacy state file missing after retrofit', legacyStateFile, 'not found'));
    } else {
      const content = JSON.parse(readFileSync(legacyStateFile, 'utf-8'));
      results.push(content.iteration === 3
        ? pass(14, `legacy api/.omc/state/ralph-state.json unchanged after retrofit (no auto-migration)`)
        : fail(14, 'legacy file content changed unexpectedly',
            JSON.stringify({ iteration: 3 }), JSON.stringify(content)));
    }
  }

  // ── 15. rollback — OMC_DISABLE_MULTIREPO=1 ───────────────────────────────
  {
    // Documented in docs/REFERENCE.md: skips workspace marker, falls back to git-root.
    // FAIL here means the env var is documented but not yet implemented.
    const r = probeJSON(`
const root = getOmcRoot(${JSON.stringify(join(base, 'api'))});
process.stdout.write(JSON.stringify({ root }) + '\\n');
`, { OMC_DISABLE_MULTIREPO: '1' });

    if (!r.ok) {
      results.push(fail(15, `rollback probe error: ${r.error}`));
    } else {
      const { root } = r.data;
      const expectedFallback = join(base, 'api', '.omc');
      if (root !== ws_omc && root.startsWith(join(base, 'api'))) {
        results.push(pass(15, `OMC_DISABLE_MULTIREPO=1 bypasses workspace anchor → api/.omc`));
      } else if (root === ws_omc) {
        results.push(fail(15,
          'OMC_DISABLE_MULTIREPO=1 NOT implemented — documented in REFERENCE.md but not yet honoured in getOmcRoot()',
          expectedFallback, root));
      } else {
        results.push(fail(15, 'OMC_DISABLE_MULTIREPO=1 returned unexpected path', expectedFallback, root));
      }
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  for (const dir of [base, retrofitBase, _probeDir].filter(Boolean)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== 15-item checklist ===\n');
  let passed = 0, failed = 0;
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  ${icon} [${String(r.n).padStart(2)}] ${r.status.padEnd(4)}  ${r.msg}`);
    if (r.status === 'FAIL' && r.expected !== undefined) {
      console.log(`          expected: ${r.expected}`);
      console.log(`          observed: ${r.observed}`);
    }
    if (r.status === 'PASS') passed++; else failed++;
  }
  console.log(`\n  Total: ${passed} PASS, ${failed} FAIL out of ${results.length} assertions\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(2); });
