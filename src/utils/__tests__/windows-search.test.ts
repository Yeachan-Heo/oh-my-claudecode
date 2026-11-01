import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, hardenWindowsExeSearch } from '../windows-search.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';
const isWin = process.platform === 'win32';
const [uvMajor, uvMinor] = process.versions.uv.split('.').map(Number);
/** libuv 1.48+ (Node 21.7+/22+) reads the variable from the spawning process's own env. */
const libuvHonorsNoCwdSearch = uvMajor > 1 || uvMinor >= 48;

/** The env minus every case variant of the variable: Claude Code's shell sets it, which would make these tests pass vacuously. */
function withoutVariable(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== VARIABLE.toUpperCase()));
}

describe.skipIf(!isWin)('hardenWindowsExeSearch / childEnv with real processes (win32 only)', () => {
  let saved: NodeJS.ProcessEnv;
  let plant: string;
  let scripts: string;

  beforeEach(() => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === VARIABLE.toUpperCase()) delete process.env[key];
    }
    plant = mkdtempSync(join(tmpdir(), 'omc-winsearch-plant-'));
    scripts = mkdtempSync(join(tmpdir(), 'omc-winsearch-scripts-'));
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(plant, { recursive: true, force: true });
    rmSync(scripts, { recursive: true, force: true });
  });

  /** Runs a node child in the planted folder that spawns `zzprobe` by bare name, optionally hardening first. */
  function probeChild(harden: boolean): { ran: boolean; code?: string } {
    // hostname.exe stands in for a planted binary: harmless, and it exits 0 when it runs.
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), join(plant, 'zzprobe.exe'));
    const child = join(scripts, 'child.cjs');
    writeFileSync(child, [
      `const { hardenWindowsExeSearch } = require(${JSON.stringify(join(ROOT, 'scripts', 'lib', 'windows-search.cjs'))});`,
      `if (process.argv[2] === 'harden') hardenWindowsExeSearch();`,
      `const r = require('child_process').spawnSync('zzprobe', [], { encoding: 'utf8', windowsHide: true });`,
      `process.stdout.write(JSON.stringify({ ran: !r.error && r.status === 0, code: r.error && r.error.code }));`,
    ].join('\n'));
    const res = spawnSync(process.execPath, [child, harden ? 'harden' : 'plain'], {
      cwd: plant, encoding: 'utf8', env: withoutVariable(process.env), windowsHide: true,
    });
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout);
  }

  it('a process that hardens does not run an exe planted in its cwd (libuv 1.48+)', () => {
    expect(probeChild(false).ran).toBe(true); // red control: without the call the plant runs
    if (libuvHonorsNoCwdSearch) {
      expect(probeChild(true)).toEqual({ ran: false, code: 'ENOENT' });
    } else {
      // libuv 1.46 (Node 20) ignores the variable; only the cmd.exe route is closed there (#4746).
      expect(probeChild(true).ran).toBe(true);
    }
  });

  it('childEnv keeps cmd.exe (shell: true) from running a planted .cmd', () => {
    writeFileSync(join(plant, 'zzprobe.cmd'), '@echo PLANTED\r\n');
    const run = (env: NodeJS.ProcessEnv) => spawnSync('zzprobe', { cwd: plant, encoding: 'utf8', shell: true, env, windowsHide: true });
    const stripped = withoutVariable(process.env);
    expect(run(stripped).stdout).toContain('PLANTED'); // red control: without childEnv cmd.exe runs the plant
    const hardened = run(childEnv(stripped));
    expect(hardened.stdout).not.toContain('PLANTED');
    expect(hardened.status).not.toBe(0);
  });

  it('hardenWindowsExeSearch replaces every case variant with one =1 entry, idempotently', () => {
    process.env.nodefaultcurrentdirectoryinexepath = '0';
    hardenWindowsExeSearch();
    hardenWindowsExeSearch();
    const keys = Object.keys(process.env).filter((key) => key.toUpperCase() === VARIABLE.toUpperCase());
    expect(keys).toEqual([VARIABLE]);
    expect(process.env[VARIABLE]).toBe('1');
  });

  it('childEnv returns a copy with case variants dropped and =1 set', () => {
    const input = { PATH: 'x', nodefaultcurrentdirectoryinexepath: '' };
    expect(childEnv(input)).toEqual({ PATH: 'x', [VARIABLE]: '1' });
    expect(input).toEqual({ PATH: 'x', nodefaultcurrentdirectoryinexepath: '' });
  });
});

describe('every Node entry point hardens the Windows executable search', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  const hardens = (rel: string) => /windows-search\.(js|mjs|cjs)['"]/.test(read(rel)) && /^\s*hardenWindowsExeSearch\(\);/m.test(read(rel));
  // A bundled library, not a process: skill-bridge.cjs is require()d by skill-injector.mjs.
  const LIBRARY_BUNDLES = new Set(['src/hooks/learner/bridge.ts']);

  function entryPoints(): string[] {
    const found = new Set<string>();
    // Sources of every esbuild bundle (bridge/*.cjs, bridge/team.js); the package bins load bridge/cli.cjs.
    for (const name of readdirSync(join(ROOT, 'scripts')).filter((n) => /^build-.*\.mjs$/.test(n))) {
      for (const m of read(`scripts/${name}`).matchAll(/entryPoints:\s*\[([^\]]*)\]/g)) {
        for (const src of m[1].matchAll(/['"]([^'"]+)['"]/g)) if (!LIBRARY_BUNDLES.has(src[1])) found.add(src[1]);
      }
    }
    // Claude Code hooks: the script node runs first (the runner).
    for (const m of read('hooks/hooks.json').matchAll(/"command":\s*"node \\"\$\{CLAUDE_PLUGIN_ROOT\}\\"\/([^ "\\]+)/g)) found.add(m[1]);
    // Scripts that skills and commands run with `node <root>/scripts/x.mjs`, plus skill-local scripts.
    for (const dir of ['skills', 'commands']) {
      if (!existsSync(join(ROOT, dir))) continue;
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        if (/\/scripts\/[^/]+\.(mjs|cjs|js)$/.test(rel)) found.add(rel);
        if (!rel.endsWith('.md')) continue;
        for (const m of readFileSync(file, 'utf8').matchAll(/\bnode\s+"?[^\s"]*?\b(scripts\/[\w./-]+\.(?:mjs|cjs|js))/g)) {
          if (existsSync(join(ROOT, m[1]))) found.add(m[1]);
        }
      }
    }
    // Legacy installs copy templates/hooks/*.mjs to ~/.claude/hooks, and node runs each one directly.
    for (const name of readdirSync(join(ROOT, 'templates', 'hooks')).filter((n) => n.endsWith('.mjs'))) found.add(`templates/hooks/${name}`);
    found.add('scripts/run-provider-advisor.js'); // `omc ask` spawns it
    found.add('src/hud/index.ts'); // the HUD statusline wrapper imports dist/hud/index.js
    return [...found].sort();
  }

  it('finds the known entry points', () => {
    const found = entryPoints();
    for (const known of ['scripts/run.cjs', 'src/cli/index.ts', 'src/cli/team.ts', 'src/mcp/standalone-server.ts', 'src/mcp/team-server.ts',
      'src/team/runtime-cli.ts', 'src/team/bridge-entry.ts', 'scripts/cleanup-orphans.mjs', 'templates/hooks/pre-tool-use.mjs']) {
      expect(found).toContain(known);
    }
  });

  it('each entry point imports and calls hardenWindowsExeSearch()', () => {
    expect(entryPoints().filter((rel) => !hardens(rel))).toEqual([]);
  });

  it('the installed hook copy of the helper matches scripts/lib', () => {
    expect(read('templates/hooks/lib/windows-search.mjs')).toBe(read('scripts/lib/windows-search.mjs'));
  });
});
