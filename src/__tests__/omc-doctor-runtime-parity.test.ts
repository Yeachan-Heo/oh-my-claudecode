import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CLAUDE_MD_VERSION, ROOT, runCommand, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

// Step 4 of the doctor names the plugin version that SessionStart (getPluginVersion in scripts/session-start.mjs) would compare with the
// CLAUDE.md marker. This test loads the runtime functions from the source text, runs them in a vm on the same cache directory, in the same
// listing order, and requires the doctor to print the very same version. Any difference is a defect of the doctor: the runtime is the model.
const RUNTIME = readFileSync(path.join(ROOT, 'scripts', 'session-start.mjs'), 'utf8');
const source = (name: string) => {
  const start = RUNTIME.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in scripts/session-start.mjs`);
  return RUNTIME.slice(start, RUNTIME.indexOf('\n}\n', start) + 3);
};
const FUNCTIONS = ['readJsonFile', 'parseSemver', 'semverCompare', 'getPluginCacheBase', 'isPathInsideOrEqual', 'isManagedPluginCacheRoot', 'getLatestPluginCacheVersion', 'getPluginVersion'];

const reorder = (names: string[], order: string[]) => [...order.filter((name) => names.includes(name)), ...names.filter((name) => !order.includes(name))];

// getPluginVersion() of the runtime for a configuration directory, the root the session loaded and the listing order of the cache.
function runtimeVersion(configDir: string, root: string, order: string[]): unknown {
  const cacheBase = path.join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
  const sandbox = {
    existsSync,
    readFileSync,
    readdirSync: (dir: string, ...rest: unknown[]) => {
      const names = (readdirSync as (...args: unknown[]) => string[])(dir, ...rest);
      return dir === cacheBase ? reorder(names, order) : names;
    },
    join: path.join,
    relative: path.relative,
    resolve: path.resolve,
    isAbsolute: path.isAbsolute,
    configDir,
    process: { env: { CLAUDE_PLUGIN_ROOT: root } },
  };
  return vm.runInNewContext(`${FUNCTIONS.map(source).join('\n')}\ngetPluginVersion()`, sandbox);
}

// Names of cache directories, among them one with a letter outside ASCII (written as an escape) and ones with trailing characters.
const NAMES = [
  '5.9.0', '5.9.1', '5.10.0', '6.0.0-beta.1', '6.0.0-beta.2', '6.0.0-rc.1', '5.9.0+build', '5.9.0-beta.1+exp', '5.10.0-..', '5.10.0-',
  '5.10.0-a..b', '5.10.0-.a', '01.2.3', '5.09.0', '5.9.00', 'v5.9.0', '5.9', '5.9.0.0', '5.9.0-beta..1', '7.0.0-0', '7.0.0-alpha', '7.0.0-alpha.1',
  '7.0.0-1', '99999999999999999999.0.0', '5.99999999999999999999.0', '5.9.0.omc-stale-1', '5.9.0-beta.1.omc-stale-1', '1e3', '5.9.0 ', '5.9.0-Beta',
  '5.9.0-b_1', '5.9.0-\u00e9', '0.0.1', '0.0.0', '10.0.0-0.3.7', '6.0.0-x.7.z.92', '6.0.0-x-y-z.--', '6.1.0+0.build', '6.2.0-alpha+001', '8.0.0--',
  '8.0.0-.', '5.8.0-rc.1', '5.8.1', '5.9.0-', '5.9.0+',
];
const LOADED = '5.8.0';

type Scenario = { label: string; names: string[]; complete: (name: string, index: number) => boolean; order: string[]; rootPackage?: unknown; registryKey?: string; alternate?: string[] };

const reversed = [...NAMES].reverse();
const rotated = [...NAMES.slice(17), ...NAMES.slice(0, 17)];
// A fixed shuffle (a multiplicative step through the indexes), so that the run does not depend on a random source.
const shuffled = NAMES.map((_, i) => NAMES[(i * 7) % NAMES.length]);
const allComplete = () => true;
const oddIncomplete = (_name: string, index: number) => index % 2 === 0;

const scenarios: Scenario[] = [
  ...(
    [['listed forward', NAMES], ['listed backwards', reversed], ['listed rotated', rotated], ['listed shuffled', shuffled]] as Array<[string, string[]]>
  ).flatMap(([order, listing]) => [
    { label: `all names, ${order}, every manifest complete`, names: NAMES, complete: allComplete, order: listing },
    { label: `all names, ${order}, every other manifest incomplete`, names: NAMES, complete: oddIncomplete, order: listing },
  ]),
  // Groups of a few names each, so that a name that decides alone is seen next to its neighbours in both orders.
  ...Array.from({ length: Math.ceil(NAMES.length / 5) }, (_, g) => NAMES.slice(g * 5, g * 5 + 5)).flatMap((group, g) => [
    { label: `group ${g} ${JSON.stringify(group)} forward`, names: group, complete: allComplete, order: group },
    { label: `group ${g} backwards`, names: group, complete: allComplete, order: [...group].reverse() },
  ]),
  // The example of the review: a name its parser rejects (5.10.0-..) beside valid ones; the runtime's sort says 0 for it, so the result depends on the listing.
  ...[['5.10.0-..', '5.9.0'], ['5.9.0', '5.10.0-..'], ['5.10.0-..', '5.9.0', '5.8.1'], ['5.8.1', '5.9.0', '5.10.0-..']].map((order) => ({ label: `the review example listed ${JSON.stringify(order)}`, names: order, complete: allComplete, order })),
  // The package of the loaded root: newer, older, equal with metadata, written with a v, not a string, falsy, and missing.
  ...[['99.0.0'], ['5.7.0'], ['5.8.0+meta'], ['v5.8.0'], [580], [{ a: 1 }], [''], [null], [0], ['  ']].map(([rootPackage]) => ({ label: `the loaded package says ${JSON.stringify(rootPackage)}`, names: NAMES, complete: allComplete, order: NAMES, rootPackage })),
  // The runtime scans the omc cache for a root that is spelled inside it, whichever registry key records the root.
  { label: 'a registry key of another marketplace records the root', names: ['5.9.0'], complete: allComplete, order: ['5.9.0'], registryKey: 'oh-my-claudecode@oh-my-claudecode', alternate: ['6.0.0'] },
  { label: 'the bare registry key records the root, another cache holds a newer version', names: ['5.9.0', '5.10.0-..'], complete: allComplete, order: ['5.10.0-..', '5.9.0'], registryKey: 'oh-my-claudecode', alternate: ['6.0.0'] },
];

function makeVersion(cache: string, name: string, version: unknown) {
  mkdirSync(path.join(cache, name), { recursive: true });
  writeFileSync(path.join(cache, name, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version }));
}

describe.skipIf(process.platform === 'win32')('omc-doctor: Step 4 names the version that the runtime compares with the marker', { timeout: 300_000 }, () => {
  test('the names of the cache directories and the order of the listing are judged as the runtime judges them', () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(40);
    const differences: Array<{ label: string; doctor: string; runtime: string }> = [];
    for (const scenario of scenarios) {
      const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-parity-'));
      try {
        mkdirSync(path.join(dir, 'plugins'), { recursive: true });
        const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        const root = path.join(cache, LOADED);
        makeVersion(cache, LOADED, 'rootPackage' in scenario ? scenario.rootPackage : LOADED);
        scenario.names.forEach((name, index) => makeVersion(cache, name, scenario.complete(name, index) ? name : name + '.x'));
        for (const name of scenario.alternate ?? []) makeVersion(path.join(dir, 'plugins', 'cache', 'oh-my-claudecode', 'oh-my-claudecode'), name, name);
        writeRegistry(dir, { [scenario.registryKey ?? 'oh-my-claudecode@omc']: [{ scope: 'user', version: LOADED, installPath: root }] });
        writeFileSync(path.join(dir, 'CLAUDE.md'), `<!-- OMC:VERSION:${LOADED} -->\n`);
        const preload = path.join(dir, 'order.cjs');
        writeFileSync(preload, `const fs = require('fs'); const real = fs.readdirSync;\nfs.readdirSync = function (target, ...rest) {\n  const names = real.call(this, target, ...rest);\n  if (String(target) !== process.env.PARITY_DIR) return names;\n  const order = JSON.parse(process.env.PARITY_ORDER);\n  return [...order.filter((name) => names.includes(name)), ...names.filter((name) => !order.includes(name))];\n};\n`);
        const order = [LOADED, ...scenario.order];
        const run = runCommand(CLAUDE_MD_VERSION, dir, { env: { CLAUDE_PLUGIN_ROOT: root, PARITY_DIR: cache, PARITY_ORDER: JSON.stringify(order) }, preloads: [preload], timeout: 30_000 });
        expect(run.error).toBeUndefined();
        const printed = (run.stdout.match(/^Latest cached plugin version: (.*)$/m) ?? [])[1] ?? '(no line)';
        const expected = runtimeVersion(dir, root, order);
        const shown = expected === null || expected === undefined ? '(none)' : typeof expected === 'string' ? expected : JSON.stringify(expected);
        if (printed !== shown) differences.push({ label: scenario.label, doctor: printed, runtime: shown });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(differences).toEqual([]);
  });

  // The loaded root as the session sets it, against the registry: the doctor must name the version the runtime compares.
  type Case = { label: string; build: (dir: string) => { root: string; registry: Record<string, unknown>; env?: Record<string, string> }; none?: boolean; doctor?: string };
  const compareWithRuntime = (cases: Case[]) => {
    const differences: Array<{ label: string; doctor: string; runtime: string }> = [];
    for (const { label, build, none, doctor } of cases) {
      const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-parity-'));
      try {
        mkdirSync(path.join(dir, 'plugins'), { recursive: true });
        const { root, registry, env } = build(dir);
        writeRegistry(dir, registry);
        writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:VERSION:5.8.0 -->\n');
        const run = runCommand(CLAUDE_MD_VERSION, dir, { env: { CLAUDE_PLUGIN_ROOT: root, ...env }, timeout: 30_000 });
        expect(run.error).toBeUndefined();
        const printed = (run.stdout.match(/^Latest cached plugin version: (.*)$/m) ?? [])[1] ?? '(no line)';
        const expected = runtimeVersion(dir, root, []);
        const shown = expected === null || expected === undefined ? '(none)' : typeof expected === 'string' ? expected : JSON.stringify(expected);
        // `none`: the runtime names no version and the doctor says it cannot name one; `doctor`: a known difference, the version the doctor names instead.
        if (printed !== (none ? '(unknown)' : doctor ?? shown) || (none && shown !== '(none)') || (doctor !== undefined && shown !== '(none)')) differences.push({ label, doctor: printed, runtime: shown });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(differences).toEqual([]);
  };

  // The runtime joins the root and the file name as text (join folds a `..` after a link away), so a root spelled so names the manifest of that directory.
  test('the loaded root with a .. after a link is read as the runtime reads it', () => {
    compareWithRuntime([
      {
        label: 'a root with a .. after a link: the manifest of the text-folded directory',
        build: (dir) => {
          const checkout = path.join(dir, 'checkout');
          mkdirSync(path.join(dir, 'other', 'nested'), { recursive: true });
          makeVersion(path.join(dir), 'checkout', '5.9.0');
          makeVersion(path.join(dir), 'other', '5.8.0');
          symlinkSync(path.join(dir, 'other', 'nested'), path.join(checkout, 'link'));
          const root = `${checkout}/link/..`;
          return { root, registry: { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.9.0', installPath: root }] } };
        },
      },
    ]);
  });

  // Outside the omc cache the runtime reads the package of the loaded root whatever the registry says; a root that no entry holds is classified so too.
  test('a loaded root outside omc is read through its own package, with or without a matching registry entry', () => {
    compareWithRuntime([
      {
        label: 'a root outside omc whose registry entry moved on to a newer version',
        build: (dir) => {
          const cache = path.join(dir, 'plugins', 'cache', 'oh-my-claudecode', 'oh-my-claudecode');
          makeVersion(cache, '5.8.0', '5.8.0');
          makeVersion(cache, '5.9.0', '5.9.0');
          return { root: path.join(cache, '5.8.0'), registry: { 'oh-my-claudecode@oh-my-claudecode': [{ scope: 'user', version: '5.9.0', installPath: path.join(cache, '5.9.0') }] } };
        },
      },
      {
        label: 'a root in the omc cache, a newer version cached',
        build: (dir) => {
          const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
          makeVersion(cache, '5.8.0', '5.8.0');
          makeVersion(cache, '5.9.0', '5.9.0');
          return { root: path.join(cache, '5.8.0'), registry: { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] } };
        },
      },
    ]);
  });

  // The class "doctor against hook" in one table: the root of the session by where it lies and what it holds, with a valid registration beside it.
  test('a loaded root outside every cache is read through its own package, and without a manifest it names no version, as the runtime', () => {
    const registered = (dir: string) => {
      const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
      makeVersion(cache, '5.9.0', '5.9.0');
      return { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.9.0', installPath: path.join(cache, '5.9.0') }] };
    };
    compareWithRuntime([
      { label: 'a checkout outside every cache with its own package, a newer version registered and cached', build: (dir) => { makeVersion(dir, 'checkout', '5.8.0'); return { root: path.join(dir, 'checkout'), registry: registered(dir) }; } },
      { label: 'a checkout outside every cache that holds no package.json', none: true, build: (dir) => { mkdirSync(path.join(dir, 'checkout')); return { root: path.join(dir, 'checkout'), registry: registered(dir) }; } },
      { label: 'a root in the omc cache that holds no package.json', build: (dir) => { const registry = registered(dir); mkdirSync(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0')); return { root: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0'), registry }; } },
    ]);
  });

  // The differences that stay, each with the version the doctor names instead of the runtime's none: it has no session root to read (none set, one that
  // does not exist, two that differ), so it names the newest cached version of the registered marketplace, or none where it cannot tell which one.
  test('the doctor names the registered cache where the session has no readable root, which the runtime does not compare at all', () => {
    const registered = (dir: string) => {
      const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
      makeVersion(cache, '5.9.0', '5.9.0');
      return { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.9.0', installPath: path.join(cache, '5.9.0') }] };
    };
    compareWithRuntime([
      { label: 'no root', doctor: '5.9.0', build: (dir) => ({ root: '', registry: registered(dir) }) },
      { label: 'a root that does not exist', doctor: '5.9.0', build: (dir) => ({ root: path.join(dir, 'nowhere'), registry: registered(dir) }) },
    ]);
  });
});
