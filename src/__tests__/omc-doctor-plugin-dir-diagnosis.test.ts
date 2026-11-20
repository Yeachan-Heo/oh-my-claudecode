import { describe, test, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { read } from './helpers/omc-doctor-cache-fixture.js';
import { step1 } from './helpers/omc-doctor-step1.js';

// The diagnosis of the omc-doctor skill is prose that the model applies to the Step 1 output; nothing in the repo
// executes it. This file therefore tests the two halves it can: Step 1 for a checkout without a readable version in
// each channel, and the diagnosis text, from which the verdict for a Step 1 output is derived mechanically below.
const skill = read('skills/omc-doctor/SKILL.md');
const diagnosis = skill.slice(skill.indexOf('**Diagnosis**'), skill.indexOf('### Step 2'));
const bullets = diagnosis.split('\n').filter((l) => l.startsWith('- '));

// A checkout whose metadata holds no usable version, in the ways a read can fail or yield nothing.
const layouts: Array<[string, (root: string) => void]> = [
  ['package.json without a version', (root) => writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode' }))],
  ['plugin.json without a version', (root) => {
    mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-claudecode' }));
  }],
  ['both files without a version', (root) => {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: '' }));
    mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-claudecode' }));
  }],
  ['a version that is not a semantic version', (root) => writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '999x.0.0' }))],
  ['metadata that cannot be parsed', (root) => writeFileSync(path.join(root, 'package.json'), '{ not json')],
  // A directory where the file should be: reading it fails with an error other than a missing file.
  ['metadata whose read fails', (root) => mkdirSync(path.join(root, 'package.json'), { recursive: true })],
  ['no metadata at all', () => undefined],
];

const checkout = (dir: string, make: (root: string) => void) => {
  const root = path.join(dir, 'checkout');
  mkdirSync(root, { recursive: true });
  make(root);
  return root;
};

// The verdict of the no-install rule, read from the rule's own text: the channels it names before "never under" are
// the ones where `Installed: (none)` means nothing is installed.
const noInstall = bullets.find((b) => b.startsWith('- If no version installed')) ?? '';
const [applies, excluded = ''] = noInstall.split('never under');
const channelsIn = (text: string) => [...text.matchAll(/`Channel: ([a-z-]+)`/g)].map((m) => m[1]);
const criticalNotInstalled = (out: Record<string, string>) => {
  const channel = out.Channel.split(' ')[0];
  // A rule that names no channel is unconditional: it reads `(none)` the same way under every channel.
  const named = channelsIn(applies);
  return out.Installed === '(none)' && (!named.length || named.includes(channel)) && !channelsIn(excluded).includes(channel);
};

describe('omc-doctor: the missing-install diagnosis is channel-aware', { timeout: 120_000 }, () => {
  test('a loaded plugin-dir checkout without a readable version prints Installed (none) and is never a missing install', () => {
    for (const [label, make] of layouts) {
      let root = '';
      const out = step1({ env: (dir) => ({ OMC_PLUGIN_ROOT: (root = checkout(dir, make)) }) });
      expect({ label, out: { Channel: out.Channel, Installed: out.Installed, 'Plugin root': out['Plugin root'] } }).toEqual({
        label, out: { Channel: 'plugin-dir', Installed: '(none)', 'Plugin root': root },
      });
      expect({ label, critical: criticalNotInstalled(out) }).toEqual({ label, critical: false });
    }
  });

  test('the same checkout still wins when the registry cannot be read or pins another install', () => {
    for (const [label, make] of layouts) {
      for (const raw of ['{ not json', undefined]) {
        const out = step1({
          ...(raw === undefined ? { plugins: { 'oh-my-claudecode@omc': [{ version: '5.8.0' }] }, cache: { omc: ['5.8.0'] } } : { raw }),
          env: (dir) => ({ OMC_PLUGIN_ROOT: checkout(dir, make) }),
        });
        expect({ label, raw, channel: out.Channel, critical: criticalNotInstalled(out) }).toEqual({ label, raw, channel: 'plugin-dir', critical: false });
      }
    }
  });

  test('the same layout as a marketplace install, or no install at all (npm), is still a missing install', () => {
    for (const [label, make] of layouts) {
      const market = step1({ plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: checkout(dir, make) }] }) });
      // A version that is present but not a semantic version damages the entry: that is the unknown channel (CRITICAL
      // by its own rule), not a missing install; every other layout is a marketplace install with no version.
      const damaged = label === 'a version that is not a semantic version';
      expect({ label, channel: market.Channel.split(' ')[0], installed: market.Installed, critical: criticalNotInstalled(market) }).toEqual({
        label, channel: damaged ? 'unknown' : 'marketplace', installed: damaged ? undefined : '(none)', critical: !damaged,
      });
    }
    const npm = step1({});
    expect({ channel: npm.Channel, installed: npm.Installed, critical: criticalNotInstalled(npm) }).toEqual({ channel: 'npm', installed: '(none)', critical: true });
  });

  test('a channel that is unknown prints no Installed line, so the no-install rule cannot read it', () => {
    const out = step1({ raw: '{ not json' });
    expect(out.Channel).toMatch(/^unknown/);
    expect(out.Installed).toBeUndefined();
    expect(criticalNotInstalled({ Channel: out.Channel, Installed: out.Installed ?? '' })).toBe(false);
  });

  test('the diagnosis text reads the channel before every rule that reads Installed, Latest or Updater', () => {
    const first = bullets.findIndex((b) => b.includes('Read the `Channel:` line of each plugin before any rule below'));
    expect(first).toBe(0);
    for (const word of ['`Installed:`', '`Latest:`', '`Updater:`']) expect(bullets[first]).toContain(word);
    expect(bullets[first]).toContain('`Channel: plugin-dir` is a loaded checkout');
    // The rules read only the channels they name, and the two install channels are installs.
    expect(bullets[first]).toContain('applies only to the channels it names');
    expect(bullets[first]).toContain('`Channel: npm` and `Channel: marketplace` are installs');
    expect(applies).toContain('`Channel: npm` or `Channel: marketplace`');
    expect(channelsIn(applies).sort()).toEqual(['marketplace', 'npm']);
    expect(channelsIn(excluded)).toEqual(['plugin-dir']);
  });

  test('every diagnosis rule that reads a missing version or a missing latest names the channels it applies to', () => {
    const reads = bullets.filter((b) => /\(none\)|no version installed|not installed|Latest: \(unavailable\)|latest: \(unavailable\)/.test(b));
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const b of reads) expect({ rule: b.slice(0, 60), channel: /`Channel: [a-z-]+`|marketplace channel|npm channel|Channel: npm/.test(b) }).toEqual({ rule: b.slice(0, 60), channel: true });
  });

  test('the plugin-dir rule says the report is OK with the version unknown and never calls the loaded checkout absent', () => {
    const rule = bullets.find((b) => b.startsWith('- If `Channel: plugin-dir`')) ?? '';
    expect(rule).toContain('reading it failed');
    expect(rule).toContain('is an unknown version of a checkout the session is running, not a missing install');
    expect(rule).toContain('never `CRITICAL - plugin not installed`');
    expect(rule).toContain('OK with the detail `plugin-dir checkout, version unknown`');
    // The rule never makes the checkout a critical finding.
    expect(rule).not.toMatch(/is CRITICAL/);
  });
});
