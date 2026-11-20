import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { commands, commandWith, digitVersions, makeCache, movedAside, PLUGIN_ID, runCommand, scriptOf, sharedSections, skillText, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1, versionCommand } from './helpers/omc-doctor-step1.js';

// Semantic versions put no bound on a numeric part, so the skill orders the numeric parts of a version (the three parts of
// the core and the numeric identifiers of a prerelease) as digit strings, the way `compareVersions` in
// src/utils/semver-compare.ts does: without leading zeros, the longer string is the larger number, equal lengths compare
// as text. A subtraction of the parts as numbers loses precision past 2^53 (`999999999999999999999` and
// `1000000000000000000000` are one double, and 400 digits are `Infinity`), so the final text tie-break then put the older
// version first. The comparator exists as one definition in Step 1 and in Step 4, and the registry commands never order versions.
const skill = skillText;
const step1Line = versionCommand ?? '';
const step4Line = commandWith('Latest cached plugin version') ?? '';
// The comparator of a command: its shared version grammar and version order sections, evaluated, giving `compareVersions`.
const orderOf = (command: string) => sharedSections(command).get('version order') ?? '';
const comparatorOf = (command: string) => vm.runInNewContext(`${sharedSections(command).get('version grammar')}\n${orderOf(command)}\n;compareVersions`, {}) as (a: string, b: string) => number;

const LOW = '999999999999999999999';
const HIGH = '1000000000000000000000';
const posix = process.platform !== 'win32';

describe('omc-doctor: numeric parts of a version are ordered as digit strings of any size', { timeout: 120_000 }, () => {
  describe('one definition', () => {
    test('the digit-string comparison is the same text in Step 1 and Step 4, and no version part becomes a number', () => {
      const texts = [step1Line, step4Line].map(orderOf);
      expect(texts[0]).toContain('const compareVersions = ');
      expect(texts[1]).toBe(texts[0]);
      expect(texts[0]).not.toMatch(/Number|parseInt|parseFloat|BigInt|\+x|\+y|x - y/);
      expect(scriptOf(step4Line)).toContain('.filter(isVersionDir).sort(compareVersions);');
      // The only number conversions in the whole skill are the process id checks of the two registry commands.
      const conversions = [...skill.matchAll(/\b(?:Number|parseInt|parseFloat|BigInt)\b[.(]?\w*/g)].map((m) => m[0]).filter((c) => c !== 'Number.isSafeInteger');
      expect(conversions).toEqual([]);
    });
  });

  describe('the comparator of both commands', () => {
    // Both commands carry the same shared section; each one is evaluated as written.
    const comparators = [step1Line, step4Line].map(comparatorOf);
    const parts = ['0', '1', '2', '9', '10', '99', '100', '9007199254740991', '9007199254740992', '9007199254740993', LOW, HIGH, '1000000000000000000001', '100000000000000000000000000000', `${'9'.repeat(400)}`, `1${'0'.repeat(400)}`, `1${'0'.repeat(399)}1`];
    const zeros = (digits: string) => (digits.length > 1 && digits[0] !== '0' ? [`0${digits}`, `${'0'.repeat(25)}${digits}`] : []);
    const sign = (n: number) => Math.sign(n);

    test('three parts of the core: the order is the order of the numbers, in every position and with leading zeros', () => {
      const names = parts.flatMap((p) => [p, ...zeros(p)]);
      for (const compare of comparators) {
        for (const a of names) {
          for (const b of names) {
            const expected = sign(Number(BigInt(a) > BigInt(b)) - Number(BigInt(a) < BigInt(b)));
            if (!expected) continue;
            for (const make of [(n: string) => `${n}.0.0`, (n: string) => `5.${n}.0`, (n: string) => `5.9.${n}`]) {
              expect({ a: make(a).slice(0, 40), b: make(b).slice(0, 40), got: sign(compare(make(a), make(b))) }).toEqual({ a: make(a).slice(0, 40), b: make(b).slice(0, 40), got: expected });
            }
          }
        }
      }
    });

    test('numeric identifiers of a prerelease: the same order, below an alphanumeric identifier, and below the release', () => {
      const names = parts.flatMap((p) => [p, ...zeros(p)]);
      for (const compare of comparators) {
        for (const a of names) {
          for (const b of names) {
            const expected = sign(Number(BigInt(a) > BigInt(b)) - Number(BigInt(a) < BigInt(b)));
            if (expected) expect(sign(compare(`5.9.0-beta.${a}`, `5.9.0-beta.${b}`))).toBe(expected);
          }
          expect(compare(`5.9.0-${a}`, '5.9.0-alpha')).toBeLessThan(0);
          expect(compare('5.9.0-alpha', `5.9.0-${a}`)).toBeGreaterThan(0);
          expect(compare(`5.9.0-${a}`, '5.9.0')).toBeLessThan(0);
        }
      }
    });

    test('equal numbers are told apart by their text, the same in both orders, and ordinary versions keep their order', () => {
      for (const compare of comparators) {
        expect(compare(`5.${HIGH}.0`, `5.0${HIGH}.0`)).not.toBe(0);
        expect(sign(compare(`5.${HIGH}.0`, `5.0${HIGH}.0`))).toBe(-sign(compare(`5.0${HIGH}.0`, `5.${HIGH}.0`)));
        expect(compare('5.9.0', '5.9.0')).toBe(0);
        const chain = ['5.8.9', '5.9.0-2', '5.9.0-10', '5.9.0-alpha', '5.9.0-alpha.1', '5.9.0-beta.2', '5.9.0-beta.10', '5.9.0', '5.9.1-alpha', '5.9.10', '5.10.0-beta', '5.10.0', 'v5.10.1', '6.0.0'];
        expect([...chain].reverse().sort(compare)).toEqual(chain);
      }
    });
  });

  describe('Step 1 and Step 4 on a profile with such versions', () => {
    const cores: Array<[string, string]> = [
      [`5.${LOW}.0`, `5.${HIGH}.0`],
      [`5.9.${LOW}`, `5.9.${HIGH}`],
      [`${LOW}.0.0`, `${HIGH}.0.0`],
      [`5.9.0-beta.${LOW}`, `5.9.0-beta.${HIGH}`],
      [`5.9.0-${LOW}`, `5.9.0-${'0'.repeat(4)}${HIGH}`],
      [`5.9.0-beta.${'9'.repeat(400)}`, `5.9.0-beta.1${'0'.repeat(400)}`],
    ];

    test('the registry entries of two scopes: the higher version is Installed, in either order of the entries', () => {
      for (const [low, high] of cores) {
        for (const versions of [[low, high], [high, low]]) {
          const out = step1({ plugins: { [PLUGIN_ID]: versions.map((version, i) => ({ scope: i ? 'project' : 'user', version })) }, clone: { omc: '9.9.9' } });
          expect({ low: low.slice(0, 40), first: versions[0] === low, installed: out.Installed }).toEqual({ low: low.slice(0, 40), first: versions[0] === low, installed: high });
        }
      }
    });

    test('the cache directories of the npm channel, and an entry that names only an installPath: the higher version is Installed', () => {
      for (const [low, high] of cores.slice(0, 4)) {
        expect({ low: low.slice(0, 40), installed: step1({ cache: { omc: [high, low] } }).Installed }).toEqual({ low: low.slice(0, 40), installed: high });
        expect({ low: low.slice(0, 40), installed: step1({ cache: { omc: [low, high] } }).Installed }).toEqual({ low: low.slice(0, 40), installed: high });
        const named = step1({
          plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: '/nowhere/one/' + low }, { scope: 'project', installPath: '/nowhere/two/' + high }] },
          cache: { omc: [low, high] },
        });
        expect({ low: low.slice(0, 40), installed: named.Installed }).toEqual({ low: low.slice(0, 40), installed: high });
      }
    });

    test('cache names with leading zeros are no versions, and a registry prerelease with zeros is the number it spells', () => {
      // A numeric part with a leading zero is outside the grammar: such a name takes no part, whatever it would spell.
      expect(step1({ cache: { omc: [`5.${LOW}.0`, `5.0000${HIGH}.0`] } }).Installed).toBe(`5.${LOW}.0`);
      expect(step1({ cache: { omc: [`5.${LOW}.0`, `5.00001.0`] } }).Installed).toBe(`5.${LOW}.0`);
      expect(step1({ cache: { omc: [`5.${'0'.repeat(30)}1.0`, '5.2.0'] } }).Installed).toBe('5.2.0');
      // A long run of zeros before a small number does not make it the larger one (a registry version may carry them in a prerelease).
      const registry = step1({ plugins: { [PLUGIN_ID]: [{ scope: 'user', version: `5.9.0-beta.${'0'.repeat(30)}1` }, { scope: 'project', version: '5.9.0-beta.2' }] }, clone: { omc: '9.9.9' } });
      expect(registry.Installed).toBe('5.9.0-beta.2');
    });

    test.skipIf(!posix)('Step 4 names the highest cached version of such names', () => {
      for (const [low, high] of cores.slice(0, 4)) {
        const { dir } = makeCache([low, high]);
        try {
          writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:VERSION:5.9.0 -->\n');
          // A shell command (a `node -e` in double quotes), so it runs through bash.
          const run = spawnSync('/bin/bash', ['-c', step4Line], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } });
          expect(run.error).toBeUndefined();
          expect({ low: low.slice(0, 40), line: run.stdout.split('\n').find((l) => l.startsWith('Latest cached plugin version:')) }).toEqual({ low: low.slice(0, 40), line: `Latest cached plugin version: ${high}` });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  });

  // The registry commands never order versions: a pin keeps the directory of exactly that version name (the runtime purge keeps the
  // directories of the registered install paths the same way, and compares precedence only to choose among them), so two names
  // that are one double, or the same number with and without leading zeros in a prerelease, are two versions, and a pinned
  // large version is accepted by the same grammar as any other (the names stay below the 255 bytes a directory name may have).
  describe('both registry commands', () => {
    const pairs = [[`5.${LOW}.0`, `5.${HIGH}.0`], [`5.9.0-beta.${HIGH}`, `5.9.0-beta.0${HIGH}`], [`5.9.0-beta.${'9'.repeat(200)}`, `5.9.0-beta.1${'0'.repeat(200)}`]];

    test('two pinned large versions and a free one: only the free one moves, whatever the order of the pins', () => {
      for (const command of commands) {
        for (const big of pairs) {
          for (const pins of [big, [...big].reverse()]) {
            const { dir, cache } = makeCache(['5.7.0', ...big]);
            try {
              writeRegistry(dir, { [PLUGIN_ID]: pins.map((version, i) => ({ scope: i ? 'project' : 'user', version, installPath: path.join(cache, version) })) });
              const result = runCommand(command, dir, { timeout: 20_000 });
              expect(result.error).toBeUndefined();
              expect({ pins: pins.map((p) => p.slice(0, 30)), versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ pins: pins.map((p) => p.slice(0, 30)), versions: [...big].sort().join(','), moved: 1 });
              expect(result.stdout).toContain('Moved 1 unprotected version(s)');
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        }
      }
    });

    test('a pin on one of two such versions does not protect the other', () => {
      for (const command of commands) {
        for (const big of pairs) {
          for (const pinned of big) {
            const { dir, cache } = makeCache(big);
            try {
              writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: pinned }] });
              const result = runCommand(command, dir, { timeout: 20_000 });
              expect(result.error).toBeUndefined();
              expect({ pinned: pinned.slice(0, 30), versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ pinned: pinned.slice(0, 30), versions: pinned, moved: 1 });
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        }
      }
    });
  });
});
