/**
 * Vitest globalSetup: rebuild `bridge/cli.cjs` if stale.
 *
 * A handful of e2e tests (skill-omc-setup.e2e, setup-progress-script) spawn
 * the real bundled CLI at `bridge/cli.cjs`. If the bundle is missing or older
 * than any source file under `src/`, those tests silently exercise stale code
 * and fail with confusing "unknown option" errors after a rebase.
 *
 * This setup runs once per `vitest` invocation (before any test file imports),
 * detects staleness via mtime, and shells out to `npm run build:cli` to refresh
 * the bundle. No-op when the bundle is already current.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(REPO_ROOT, 'bridge', 'cli.cjs');
const SRC_DIR = join(REPO_ROOT, 'src');
const TS_EXT = new Set(['.ts', '.mts', '.cts']);
const SKIP_DIRS = new Set(['__tests__', '__fixtures__', 'node_modules']);

function maxTsMtime(dir) {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const m = maxTsMtime(p);
      if (m > max) max = m;
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot > 0 && TS_EXT.has(entry.name.slice(dot))) {
        const m = statSync(p).mtimeMs;
        if (m > max) max = m;
      }
    }
  }
  return max;
}

export default function setup() {
  if (process.env.OMC_SKIP_CLI_REBUILD === '1') return;

  const bundleMtime = existsSync(BRIDGE) ? statSync(BRIDGE).mtimeMs : 0;
  const sourceMtime = maxTsMtime(SRC_DIR);
  if (bundleMtime && bundleMtime >= sourceMtime) return;

  const reason = bundleMtime === 0 ? 'missing' : 'stale';
  process.stdout.write(
    `[test-ensure-cli-built] bridge/cli.cjs is ${reason}, running \`npm run build:cli\`...\n`,
  );
  execSync('npm run build:cli', { cwd: REPO_ROOT, stdio: 'inherit' });
}
