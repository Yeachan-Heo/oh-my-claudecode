import { describe, test, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PLUGIN_ID, read } from './helpers/omc-doctor-cache-fixture.js';
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
const [applies, ...exclusions] = noInstall.split('never under');
const excluded = exclusions.join(' ');
const channelsIn = (text: string) => [...text.matchAll(/`Channel: ([a-z-]+)`/g)].map((m) => m[1]);
const criticalNotInstalled = (out: Record<string, string>) => {
  const channel = out.Channel.split(' ')[0];
  // A rule that names no channel is unconditional: it reads `(none)` the same way under every channel.
  const named = channelsIn(applies);
  return out.Installed === '(none)' && (!named.length || named.includes(channel)) && !channelsIn(excluded).includes(channel);
};

// The severity the diagnosis gives to a Step 1 output, read from the text of the rules: the rule whose head names the
// Installed value in backticks and the channel of the output (the channels it excludes follow "never under"), and the
// severity word after its head. 'none' when no rule that reads that value applies.
const severityOf = (out: Record<string, string>) => {
  const channel = out.Channel.split(' ')[0];
  for (const b of bullets) {
    const found = b.match(/^- If (.*?): (CRITICAL|WARN)\b/);
    if (!found || !found[1].includes('`Installed: ' + out.Installed + '`')) continue;
    const [named, ...rest] = found[1].split('never under');
    const channels = channelsIn(named);
    if ((!channels.length || channels.includes(channel)) && !channelsIn(rest.join(' ')).includes(channel)) return found[2];
  }
  return 'none';
};
// A link that points at nothing in place of the cache directory (POSIX): the cache cannot be read.
const unreadableCache = (dir: string) => {
  mkdirSync(path.join(dir, 'plugins', 'cache', 'omc'), { recursive: true });
  symlinkSync('no-such-target', path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode'));
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

  test('the same layout as a marketplace install is an install of unknown version, only no install at all (npm) is a missing install', () => {
    for (const [label, make] of layouts) {
      const market = step1({ plugins: (dir) => ({ [PLUGIN_ID]: [{ installPath: checkout(dir, make) }] }) });
      // A version that is present but not a semantic version damages the entry: that is the unknown channel (CRITICAL
      // by its own rule); every other layout is a marketplace install whose version is unknown, a warning.
      const damaged = label === 'a version that is not a semantic version';
      expect({ label, channel: market.Channel.split(' ')[0], installed: market.Installed, critical: criticalNotInstalled(market), severity: damaged ? undefined : severityOf(market) }).toEqual({
        label, channel: damaged ? 'unknown' : 'marketplace', installed: damaged ? undefined : '(unknown)', critical: false, severity: damaged ? undefined : 'WARN',
      });
    }
    const npm = step1({});
    expect({ channel: npm.Channel, installed: npm.Installed, critical: criticalNotInstalled(npm), severity: severityOf(npm) }).toEqual({ channel: 'npm', installed: '(none)', critical: true, severity: 'CRITICAL' });
  });

  // The review's case: an entry that has only an installPath, and the root the session loads from it holds no version
  // metadata. The registry and the loaded root prove the plugin is there, so the final diagnosis is a warning about an
  // unknown version and never the missing-install one that sends the user to a reinstall.
  test('an entry with only an installPath whose loaded root has no metadata is an unknown version, in every layout', () => {
    for (const [label, make] of layouts) {
      if (label === 'a version that is not a semantic version') continue;
      for (const variable of ['CLAUDE_PLUGIN_ROOT', 'OMC_PLUGIN_ROOT']) {
        let root = '';
        const out = step1({
          plugins: (dir) => ({ [PLUGIN_ID]: [{ installPath: (root = checkout(dir, make)) }] }),
          env: () => ({ [variable]: root }),
        });
        expect({ label, variable, channel: out.Channel, installed: out.Installed, critical: criticalNotInstalled(out), severity: severityOf(out) }).toEqual({
          label, variable, channel: 'marketplace omc', installed: '(unknown)', critical: false, severity: 'WARN',
        });
        expect(out.Note).toContain('the registry records no version for this install');
        expect(out.Note).toContain(`the running root ${root}`);
      }
    }
  });

  test('value, channel and evidence together: only nothing installed is (none), every install without a version is (unknown)', () => {
    const cases: Array<[string, Record<string, string>, string, string]> = [
      ['no entry, no root, an empty cache', step1({}), '(none)', 'CRITICAL'],
      ['an entry with a version', step1({ plugins: { [PLUGIN_ID]: [{ version: '5.8.0' }] } }), '5.8.0', 'none'],
      ['an entry with only an installPath that names no version, no root, no cache', step1({ plugins: { [PLUGIN_ID]: [{ installPath: '/nowhere/current' }] } }), '(unknown)', 'WARN'],
      ['an entry whose two versions differ and no manifest settles it', step1({ plugins: (dir) => ({ [PLUGIN_ID]: [{ version: '5.9.0', installPath: path.join(dir, 'x', '5.8.0') }] }) }), '(unknown)', 'WARN'],
    ];
    if (process.platform !== 'win32') cases.push(['no entry, no root, a cache that cannot be read', step1({ setup: unreadableCache }), '(unknown)', 'WARN']);
    for (const [label, out, installed, severity] of cases) expect({ label, installed: out.Installed, severity: severityOf(out) }).toEqual({ label, installed, severity });
    // The npm channel's own unknown names its reason.
    if (process.platform !== 'win32') expect(step1({ setup: unreadableCache }).Note).toContain('cannot be read, so it is unknown whether a version is installed');
    // A plugin-dir checkout has its own rule: no installed-value rule reads it, and it is never critical.
    const checkoutOut = step1({ env: (dir) => ({ OMC_PLUGIN_ROOT: checkout(dir, () => undefined) }) });
    expect({ installed: checkoutOut.Installed, severity: severityOf(checkoutOut), critical: criticalNotInstalled(checkoutOut) }).toEqual({ installed: '(none)', severity: 'none', critical: false });
  });

  test('a channel that is unknown prints no Installed line, so the no-install rule cannot read it', () => {
    const out = step1({ raw: '{ not json' });
    expect(out.Channel).toMatch(/^unknown/);
    expect(out.Installed).toBeUndefined();
    expect(criticalNotInstalled({ Channel: out.Channel, Installed: out.Installed ?? '' })).toBe(false);
  });

  test('the diagnosis text reads the channel before every rule that reads Installed, Latest or Updater', () => {
    const first = bullets.findIndex((b) => b.includes('Read the `Channel:` line of each plugin before any rule below'));
    // Only the rule for a script that did not run comes before it: it reads no line of the Step 1 output.
    expect(bullets[0]).toContain('omc-doctor: plugin files not found');
    for (const word of ['`Installed:`', '`Latest:`', '`Updater:`', '`Channel:']) expect(bullets[0]).not.toContain(word);
    expect(first).toBe(1);
    for (const word of ['`Installed:`', '`Latest:`', '`Updater:`']) expect(bullets[first]).toContain(word);
    expect(bullets[first]).toContain('`Channel: plugin-dir` is a loaded checkout');
    // The rules read only the channels they name, and the two install channels are installs.
    expect(bullets[first]).toContain('applies only to the channels it names');
    expect(bullets[first]).toContain('`Channel: npm` and `Channel: marketplace` are installs');
    expect(channelsIn(applies)).toEqual(['npm']);
    expect(channelsIn(excluded).sort()).toEqual(['marketplace', 'plugin-dir']);
    // The unknown version is its own rule, for the two install channels, a warning and never a missing install.
    const unknown = bullets.find((b) => b.startsWith('- If `Installed: (unknown)`')) ?? '';
    expect(channelsIn(unknown.split(': WARN')[0]).sort()).toEqual(['marketplace', 'npm']);
    expect(unknown).toContain('not a missing install and never CRITICAL');
    expect(unknown).toContain('compare nothing with `Latest:`');
    expect(unknown).not.toMatch(/: CRITICAL/);
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
