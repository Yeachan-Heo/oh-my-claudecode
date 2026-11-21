import { describe, test, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commands, digitVersions, makeCache, movedAside, runCommand, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1 } from './helpers/omc-doctor-step1.js';

const makeRoot = (dir: string, name: string, files: Record<string, unknown>) => {
  const root = path.join(dir, name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), JSON.stringify(body));
  }
  return root;
};
const updater = 'none (update and rebuild that checkout, then run omc setup --plugin-dir-mode)';

describe('omc-doctor: an explicit OMC_PLUGIN_ROOT inside plugins/cache', { timeout: 120_000 }, () => {
  // An explicit root is explicit wherever it lies. A cache version the registry does not pin, a directory in the cache of
  // another plugin and a path below the pinned version are checkouts of their own (the session loads exactly that
  // directory), and the cache commands still protect the directory the variable points into.
  test('a root inside plugins/cache that the registry does not pin is the loaded checkout, not the registry install', () => {
    const cacheDir = (dir: string, ...parts: string[]) => path.join(dir, 'plugins', 'cache', ...parts);
    const layouts: Array<[string, (dir: string) => string, string]> = [
      ['an older cache version', (dir) => makeRoot(dir, path.join('plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0'), { 'package.json': { version: '5.7.0' } }), '5.7.0'],
      ['a directory in the cache of another plugin', (dir) => makeRoot(dir, path.join('plugins', 'cache', 'other-market', 'other-plugin', '1.0.0'), { 'package.json': { version: '1.0.0' } }), '1.0.0'],
      ['a path below the pinned version', (dir) => makeRoot(dir, path.join('plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0', 'checkout'), { 'package.json': { version: '5.8.1' } }), '5.8.1'],
    ];
    for (const [label, make, installed] of layouts) {
      for (const withInstallPath of [true, false]) {
        let root = '';
        const out = step1({
          plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0', ...(withInstallPath ? { installPath: cacheDir(dir, 'omc', 'oh-my-claudecode', '5.8.0') } : {}) }] }),
          cache: { omc: ['5.7.0', '5.8.0'] },
          clone: { omc: '6.0.0' },
          env: (dir) => ({ OMC_PLUGIN_ROOT: (root = make(dir)) }),
        });
        expect({ label, withInstallPath, out }).toEqual({
          label, withInstallPath,
          out: { 'Plugin root': root, Channel: 'plugin-dir', Installed: installed, Latest: '(unavailable) (a --plugin-dir checkout has no update channel)', Updater: updater },
        });
      }
    }
  });

  // The registry cannot be read, so the cache directory cannot be told from the pinned install: the channel is unknown, not
  // a guess. Without any registry file there is nothing to tell it from, and the explicit root is the checkout.
  test('a root inside plugins/cache with a registry that cannot be read is unknown, with no registry at all it is the checkout', () => {
    const inCache = (dir: string) => path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0');
    for (const raw of ['{not json', '[]', 'null']) {
      const out = step1({ raw, cache: { omc: ['5.7.0', '5.8.0'] }, env: (dir) => ({ OMC_PLUGIN_ROOT: inCache(dir) }) });
      expect({ raw, keys: Object.keys(out), channel: (out.Channel ?? '').split(' ')[0] }).toEqual({ raw, keys: ['Channel'], channel: 'unknown' });
    }
    const none = step1({ cache: { omc: ['5.7.0', '5.8.0'] }, env: (dir) => ({ OMC_PLUGIN_ROOT: inCache(dir) }) });
    expect(none.Channel).toBe('plugin-dir');
  });

  test('the cache commands keep the cache version that OMC_PLUGIN_ROOT names while they move the free one', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.6.0', '5.7.0', '5.8.0']);
      try {
        writeRegistry(dir, { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
        const result = runCommand(command, dir, { env: { OMC_PLUGIN_ROOT: path.join(cache, '5.7.0') } });
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.7.0,5.8.0', moved: 1 });
        expect(result.stdout).toContain('Kept protected cache versions');
        expect(result.stdout).toContain('5.7.0');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
