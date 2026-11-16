import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = join(REPO, 'tools', 'maintenance', 'plugin_install_smoke.sh');

const have = (cmd: string[]): boolean => spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' }).status === 0;
const toolsOk =
  have(['bash', '-c', 'true']) && have(['python3', '-c', 'pass']) && have(['sha256sum', '--version']) && have(['bash', '-c', 'date +%s.%N | grep -q "\\."']);

const root = mkdtempSync(join(tmpdir(), 'plugin-smoke-test-'));
const home = join(root, 'home');
const plugin = join(root, 'plugin');
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'sentinel.txt'), 'real');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }));
  writeFileSync(join(plugin, 'hooks', 'a.txt'), 'original\n');
});

interface Run {
  status: number | null;
  out: string;
}
function run(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: '', ...env },
    timeout: 60000,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

// The phase commands edit the installed copy (SMOKE_PLUGIN_DIR) of the fake plugin tree.
const DRY = 'test -n "$CLAUDE_CONFIG_DIR"';
const APPLY = 'echo patched > "$SMOKE_PLUGIN_DIR/hooks/a.txt"';
const REVERT = 'echo original > "$SMOKE_PLUGIN_DIR/hooks/a.txt"';
const base = (extra: string[] = []) => ['--plugin-dir', plugin, '--dry-run-cmd', DRY, '--apply-cmd', APPLY, '--revert-cmd', REVERT, ...extra];
const logDir = (out: string) => /logs in (\S+)/.exec(out)![1];

describe.skipIf(!toolsOk)('plugin_install_smoke.sh', () => {
  it('passes a full run: apply changes the tree, revert restores it, the second apply reproduces it', () => {
    const r = run(base());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('SMOKE RESULT: OK');
    const logs = logDir(r.out);
    expect(existsSync(join(logs, '2-apply.log'))).toBe(true);
    // plugins/cache is deleted after the run, the logs stay
    expect(existsSync(join(logs, 'config', 'plugins', 'cache'))).toBe(false);
    expect(readdirSync(logs)).toContain('3-revert.log');
    expect(readFileSync(join(plugin, 'hooks', 'a.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(home, '.claude', 'sentinel.txt'), 'utf8')).toBe('real');
  });

  it('writes a one-entry installed_plugins.json and a 0600 fake settings.json (kept with --keep)', () => {
    const src = join(root, 'real-settings.json');
    writeFileSync(src, JSON.stringify({ env: { OMC_X: '1', CLAUDE_CODE_Y: '2', ENABLE_TOOL_SEARCH: 'true', API_TOKEN: 'abc', OTHER: 'v' }, hooks: { a: 1 } }));
    const r = run(base(['--keep', '--settings-from', src, '--marketplace', 'mk']));
    expect(r.status, r.out).toBe(0);
    const cfg = join(logDir(r.out), 'config');
    const installed = JSON.parse(readFileSync(join(cfg, 'plugins', 'installed_plugins.json'), 'utf8'));
    expect(Object.keys(installed.plugins)).toEqual(['demo@mk']);
    expect(installed.plugins['demo@mk'][0].installPath).toBe(join(cfg, 'plugins', 'cache', 'mk', 'demo', '1.2.3'));
    const settings = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
    expect(settings.env).toEqual({ OMC_X: '1', CLAUDE_CODE_Y: '2', ENABLE_TOOL_SEARCH: 'true', API_TOKEN: 'FAKE', OTHER: 'FAKE' });
    expect(settings.hooks).toEqual({});
    expect(statSync(join(cfg, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(cfg, 'plugins', 'cache', 'mk', 'demo', '1.2.3', 'hooks', 'a.txt'))).toBe(true);
  });

  it('fails when the apply does not change the tree (S0 = S1)', () => {
    const r = run(['--plugin-dir', plugin, '--dry-run-cmd', DRY, '--apply-cmd', 'true', '--revert-cmd', 'true']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('SMOKE RESULT: FAILED');
  });

  it('fails when the revert does not restore the tree (S0 != S2)', () => {
    const r = run(['--plugin-dir', plugin, '--dry-run-cmd', DRY, '--apply-cmd', APPLY, '--revert-cmd', 'true']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('SMOKE RESULT: FAILED');
  });

  it('fails when the second apply does not reproduce the first (S3 != S1)', () => {
    const apply = 'date +%s%N > "$SMOKE_PLUGIN_DIR/hooks/a.txt"';
    const r = run(['--plugin-dir', plugin, '--dry-run-cmd', DRY, '--apply-cmd', apply, '--revert-cmd', REVERT]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/sum after the second apply \S+ differs from/);
  });

  it('fails when a phase command exits non-zero', () => {
    const r = run(['--plugin-dir', plugin, '--dry-run-cmd', 'exit 3', '--apply-cmd', APPLY, '--revert-cmd', REVERT]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('exit 3');
  });

  it('fails when the revert is slower than --revert-time-limit', () => {
    const r = run(base(['--revert-time-limit', '0.2']).map((a) => (a === REVERT ? `sleep 0.5; ${REVERT}` : a)));
    expect(r.status).toBe(1);
    expect(r.out).toContain('SMOKE RESULT: FAILED');
  });

  it('leaves out --ignore-path directories from the tree sums', () => {
    const apply = `${APPLY}; mkdir -p "$SMOKE_PLUGIN_DIR/.state"; date +%s%N > "$SMOKE_PLUGIN_DIR/.state/s"`;
    const withoutIgnore = run(['--plugin-dir', plugin, '--dry-run-cmd', DRY, '--apply-cmd', apply, '--revert-cmd', `${REVERT}; rm -rf "$SMOKE_PLUGIN_DIR/.state"`]);
    expect(withoutIgnore.status).toBe(1);
    const ignored = run(['--plugin-dir', plugin, '--dry-run-cmd', DRY, '--apply-cmd', apply, '--revert-cmd', REVERT, '--ignore-path', '.state']);
    expect(ignored.status, ignored.out).toBe(0);
  });

  it('refuses the real configuration directory, a path inside it, a parent of it and a symlink to it, without writing', () => {
    const real = join(home, '.claude');
    const link = join(root, 'link-to-real');
    symlinkSync(real, link);
    for (const target of [real, join(real, 'sub'), home, link]) {
      const r = run(base(['--config-dir', target]));
      expect(r.status, `${target}: ${r.out}`).toBe(2);
      expect(r.out).toContain('refusing');
    }
    expect(readdirSync(real)).toEqual(['sentinel.txt']);
  });

  it('refuses the directory named by CLAUDE_CONFIG_DIR', () => {
    const other = join(root, 'other-config');
    mkdirSync(other);
    const r = run(base(['--config-dir', join(other, 'x')]), { CLAUDE_CONFIG_DIR: other });
    expect(r.status, r.out).toBe(2);
    expect(readdirSync(other)).toEqual([]);
  });

  it('refuses a non-empty --config-dir', () => {
    const used = join(root, 'used-config');
    mkdirSync(used);
    writeFileSync(join(used, 'f'), 'x');
    const r = run(base(['--config-dir', used]));
    expect(r.status).toBe(2);
    expect(r.out).toContain('must not exist or be empty');
  });

  it('uses an explicit empty --config-dir', () => {
    const fresh = join(root, 'fresh-config');
    const r = run(base(['--config-dir', fresh, '--keep']));
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(fresh, 'plugins', 'cache', 'local', 'demo', '1.2.3'))).toBe(true);
  });

  it('usage errors exit 2: missing options, bad plugin directory, no manifest, unknown option, missing value', () => {
    expect(run(['--plugin-dir', plugin, '--dry-run-cmd', DRY, '--apply-cmd', APPLY]).status).toBe(2);
    expect(run(base().filter((a, i, all) => a !== '--plugin-dir' && all[i - 1] !== '--plugin-dir')).status).toBe(2);
    expect(run(base().map((a) => (a === plugin ? join(root, 'nope') : a))).status).toBe(2);
    const empty = join(root, 'empty-plugin');
    mkdirSync(empty);
    expect(run(base().map((a) => (a === plugin ? empty : a))).out).toContain('no .claude-plugin/plugin.json');
    expect(run([...base(), '--bogus']).status).toBe(2);
    expect(run([...base(), '--marketplace']).status).toBe(2);
    expect(run([...base(), '--revert-time-limit', 'abc']).status).toBe(2);
    expect(run(['--help']).status).toBe(0);
  });
});
