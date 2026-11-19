import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commands, runCommand, digitVersions, movedAside, makeCache, writeRegistryFile, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

describe('omc-doctor cache commands on a synthetic config directory (the order of the checks)', { timeout: 120_000 }, () => {
  // The result must not depend on the order in which the registry, the namespace and the cache are looked at: a registry
  // that cannot be read is reported before any cache directory is probed, in whichever namespace the cache lies.
  describe('registry x OMC_PLUGIN_ROOT x cache layout', () => {
    const layouts = [
      { name: 'cache of the omc namespace', key: 'oh-my-claudecode@omc', ns: 'omc' },
      { name: 'cache of the marketplace namespace', key: 'oh-my-claudecode@oh-my-claudecode', ns: 'oh-my-claudecode' },
    ];
    const registries = ['missing', 'valid', 'invalid JSON', 'top-level array', 'null'] as const;
    const roots = ['unset', 'the pinned install', 'a free version', 'a checkout elsewhere'] as const;
    const unreadableMessage = /Nothing moved: installed_plugins\.json, .*could not be read completely; fix that first/;

    test('grid: both commands, every combination', () => {
      for (const command of commands) {
        for (const layout of layouts) {
          for (const registry of registries) {
            for (const root of roots) {
              const { dir, cache } = makeCache(['5.7.0', '5.8.0'], layout.ns);
              try {
                const raw = { 'invalid JSON': '{not json', 'top-level array': '[]', null: 'null' }[registry as string];
                if (registry === 'valid') writeRegistry(dir, { [layout.key]: [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
                else if (raw !== undefined) writeRegistryFile(dir, raw);
                const checkout = path.join(dir, 'checkout');
                mkdirSync(checkout, { recursive: true });
                const OMC_PLUGIN_ROOT = { unset: '', 'the pinned install': path.join(cache, '5.8.0'), 'a free version': path.join(cache, '5.7.0'), 'a checkout elsewhere': checkout }[root];
                const result = runCommand(command, dir, { env: { OMC_PLUGIN_ROOT } });
                expect(result.status).toBe(0);
                const got = { layout: layout.name, registry, root, versions: digitVersions(cache), moved: movedAside(dir) };
                if (registry === 'valid') {
                  // 5.8.0 is pinned; 5.7.0 is free unless the root variable points into it.
                  const protectsFree = root === 'a free version';
                  expect(got).toEqual({ layout: layout.name, registry, root, versions: protectsFree ? '5.7.0,5.8.0' : '5.8.0', moved: protectsFree ? 0 : 1 });
                  expect(result.stdout).toMatch(protectsFree ? /Nothing to move/ : /Moved 1 unprotected version/);
                } else {
                  expect(got).toEqual({ layout: layout.name, registry, root, versions: '5.7.0,5.8.0', moved: 0 });
                  if (registry === 'missing') {
                    // No entry names a namespace, so the default omc one is looked at.
                    expect(result.stdout).toMatch(layout.ns === 'omc' ? /Nothing moved: no pinned (cache )?version found/ : /No (plugin cache found|cache to clean)/);
                  } else {
                    expect({ layout: layout.name, registry, root, said: result.stdout.match(unreadableMessage)?.[0] !== undefined }).toEqual({ layout: layout.name, registry, root, said: true });
                    expect(result.stdout).not.toMatch(/No (plugin cache found|cache to clean)/);
                  }
                }
              } finally {
                rmSync(dir, { recursive: true, force: true });
              }
            }
          }
        }
      }
    });

    test('a registry that cannot be read is reported even when no cache directory exists in either namespace, and a missing one is not', () => {
      for (const command of commands) {
        for (const raw of ['{not json', '[]', 'null', '{"plugins":{"oh-my-claudecode@omc":null}}']) {
          const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
          try {
            mkdirSync(path.join(dir, 'plugins'), { recursive: true });
            writeRegistryFile(dir, raw);
            const result = runCommand(command, dir);
            expect({ raw, said: unreadableMessage.test(result.stdout) }).toEqual({ raw, said: true });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
        const none = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
        try {
          expect(runCommand(command, none).stdout).toMatch(/No (plugin cache found|cache to clean)/);
        } finally {
          rmSync(none, { recursive: true, force: true });
        }
      }
    });

    test('a registry of a good shape that names one marketplace and a cache that exists in the other namespace only still says where it looked', () => {
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.0'], 'oh-my-claudecode');
        try {
          writeRegistry(dir, { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0' }] });
          const result = runCommand(command, dir);
          expect(result.stdout).toMatch(/No (plugin cache found|cache to clean)/);
          expect({ versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ versions: '5.7.0,5.8.0', moved: 0 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  });
});
