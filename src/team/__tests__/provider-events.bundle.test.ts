import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

// The shipped launchers are CJS bundles in <package>/bridge/, beside
// <package>/scripts/. Bundle provider-events the way scripts/build-runtime-cli.mjs
// does into a temp package of that layout, so the hook command comes from the
// bundled `bridge` branch of packageRoot() and not from src/ or dist/.
describe.skipIf(process.platform === 'win32')('provider event hook from a bundled bridge/*.cjs', () => {
  let pkg = '';
  let stateRoot = '';
  let bundled: typeof import('../provider-events.js');

  beforeAll(() => {
    // The quote in the package path checks the hook command's shell quoting.
    pkg = realpathSync(mkdtempSync(join(tmpdir(), "provider-events-bundle-it's-")));
    stateRoot = join(pkg, 'state');
    mkdirSync(join(stateRoot, 'workers', 'worker-1'), { recursive: true });
    mkdirSync(join(pkg, 'scripts'));
    copyFileSync(
      join(REPO_ROOT, 'scripts', 'team-provider-event-hook.mjs'),
      join(pkg, 'scripts', 'team-provider-event-hook.mjs'),
    );
    const outfile = join(pkg, 'bridge', 'provider-events.cjs');
    buildSync({
      entryPoints: [join(REPO_ROOT, 'src', 'team', 'provider-events.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile,
      banner: { js: 'const importMetaUrl = require("url").pathToFileURL(__filename);' },
      define: { 'import.meta.url': 'importMetaUrl' },
      logLevel: 'silent',
    });
    bundled = createRequire(import.meta.url)(outfile) as typeof bundled;
    // The npm package's dist/ is ESM, where packageRoot() falls back to import.meta.url.
    buildSync({
      entryPoints: [join(REPO_ROOT, 'src', 'team', 'provider-events.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: join(pkg, 'dist', 'team', 'provider-events.mjs'),
      logLevel: 'silent',
    });
  });
  afterAll(() => { rmSync(pkg, { recursive: true, force: true }); });

  it('emits a hook command that records the event for the worker', async () => {
    const settings = JSON.parse(readFileSync(await bundled.writeProviderEventSettings(stateRoot), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const command = settings.hooks.Stop![0]!.hooks[0]!.command;
    expect(command).toContain(`'${join(pkg, 'scripts', 'team-provider-event-hook.mjs').replace(/'/g, `'"'"'`)}'`);

    const result = spawnSync('sh', ['-c', command], {
      env: {
        PATH: process.env.PATH ?? '',
        OMC_TEAM_STATE_ROOT: stateRoot,
        OMC_TEAM_WORKER: 'demo/worker-1',
        OMC_WORKER_LAUNCH_ATTEMPT_ID: 'a1',
      },
      encoding: 'utf8',
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const record = JSON.parse(readFileSync(join(stateRoot, 'workers', 'worker-1', 'provider-events.jsonl'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ v: 1, event: 'Stop', attempt: 'a1' });
  });

  it('emits the same hook command from an ESM dist/team/*.js module', () => {
    // A child process loads the module as plain ESM, without vitest's __dirname.
    const esm = pathToFileURL(join(pkg, 'dist', 'team', 'provider-events.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(esm)}); process.stdout.write(m.providerEventHookCommand('Stop'));`], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(bundled.providerEventHookCommand('Stop'));
  });
});
