import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { read, runCommand, writeRegistry, writeRegistryFile } from './helpers/omc-doctor-cache-fixture.js';

const text = read('skills/omc-doctor/SKILL.md');
const versionCommand = text.split('\n').find((l) => l.startsWith('node -e ') && l.includes("'Updater: "));

type Profile = { plugins?: Record<string, unknown>; raw?: string; cache?: Record<string, string[]>; clone?: Record<string, string> };

// Runs the Step 1 command against a synthetic config directory. `cache` maps a marketplace name to the
// version directories under plugins/cache/<marketplace>/oh-my-claudecode, `clone` maps a marketplace name
// to the plugin version its clone advertises.
function step1(profile: Profile) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-version-'));
  try {
    mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    for (const [market, versions] of Object.entries(profile.cache ?? {})) {
      for (const v of versions) mkdirSync(path.join(dir, 'plugins', 'cache', market, 'oh-my-claudecode', v), { recursive: true });
    }
    for (const [market, version] of Object.entries(profile.clone ?? {})) {
      const manifestDir = path.join(dir, 'plugins', 'marketplaces', market, '.claude-plugin');
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(path.join(manifestDir, 'marketplace.json'), JSON.stringify({ name: market, plugins: [{ name: 'oh-my-claudecode', version }] }));
    }
    if (profile.raw !== undefined) writeRegistryFile(dir, profile.raw);
    else if (profile.plugins) writeRegistry(dir, profile.plugins);
    const result = runCommand(versionCommand ?? '', dir);
    expect(result.status).toBe(0);
    return Object.fromEntries(result.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('omc-doctor Step 1 derives the plugin ID, channel and latest version from the active install', () => {
  test('the command exists once and does not consult npm or a fixed plugin ID', () => {
    expect(versionCommand).toBeDefined();
    expect(text.split('\n').filter((l) => l.startsWith('node -e ') && l.includes("'Updater: "))).toHaveLength(1);
    expect(versionCommand).not.toMatch(/npm view|registry\.npmjs|child_process/);
    // The npm line has its own label, so an offline run never prints a second `Latest:` next to a marketplace one.
    const block = text.slice(text.indexOf('### Step 1'), text.indexOf('**Diagnosis**'));
    expect(block).toContain('echo "npm latest: (unavailable)"');
    expect(block.split('\n').filter((l) => !l.startsWith('node -e ') && l.includes('Latest:') && !l.startsWith('#'))).toEqual([]);
  });

  test('npm profile: no registry entry means the npm channel, installed from the cache, updated with omc update', () => {
    expect(step1({ cache: { omc: ['5.8.0', '5.9.0'] } })).toEqual({ Channel: 'npm', Installed: '5.9.0', Updater: 'omc update' });
    expect(step1({ plugins: { 'some-other-plugin@market': [{ version: '1.0.0' }] } })).toEqual({ Channel: 'npm', Installed: '(none)', Updater: 'omc update' });
  });

  test('marketplace profile from the oh-my-claudecode marketplace: its own plugin ID, clone and updater', () => {
    const out = step1({
      plugins: { 'oh-my-claudecode@oh-my-claudecode': [{ scope: 'user', version: '5.9.0' }] },
      clone: { 'oh-my-claudecode': '5.9.0' },
    });
    expect(out).toEqual({
      Plugin: 'oh-my-claudecode@oh-my-claudecode',
      Channel: 'marketplace oh-my-claudecode',
      Installed: '5.9.0',
      Latest: '5.9.0 (marketplace clone)',
      Updater: 'claude plugin marketplace update oh-my-claudecode && claude plugin update oh-my-claudecode@oh-my-claudecode',
    });
    expect(out.Updater).not.toMatch(/\bomc\b|@omc/);
  });

  test('marketplace profile behind npm: the installed version equals the channel latest, so there is nothing to warn about', () => {
    // npm may already have a newer release; the command never reads it, only the clone the channel updates from.
    const out = step1({
      plugins: { 'oh-my-claudecode@oh-my-claudecode': [{ version: '5.8.1' }] },
      clone: { 'oh-my-claudecode': '5.8.1' },
    });
    expect(out.Installed).toBe('5.8.1');
    expect(out.Latest).toBe('5.8.1 (marketplace clone)');
  });

  test('marketplace profile with a newer clone shows the difference, and the legacy omc marketplace gets its own updater', () => {
    const out = step1({
      plugins: { 'oh-my-claudecode@omc': [{ version: '5.8.0' }, { version: '5.8.1' }] },
      clone: { omc: '5.9.0', 'oh-my-claudecode': '9.9.9' },
    });
    expect(out).toMatchObject({
      Plugin: 'oh-my-claudecode@omc',
      Channel: 'marketplace omc',
      Installed: '5.8.1',
      Latest: '5.9.0 (marketplace clone)',
      Updater: 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode@omc',
    });
  });

  test('an entry without a version falls back to the cache of its own marketplace; a missing clone is reported, not guessed', () => {
    const out = step1({
      plugins: { 'oh-my-claudecode@oh-my-claudecode': [{ installPath: '/nowhere' }] },
      cache: { 'oh-my-claudecode': ['5.7.0', '5.10.0'], omc: ['6.0.0'] },
    });
    expect(out).toMatchObject({ Installed: '5.10.0', Latest: '(unavailable) (marketplace clone)' });
  });

  test('a bare plugin ID keeps the legacy omc marketplace', () => {
    expect(step1({ plugins: { 'oh-my-claudecode': [{ version: '5.8.0' }] }, clone: { omc: '5.8.0' } })).toMatchObject({
      Plugin: 'oh-my-claudecode',
      Channel: 'marketplace omc',
      Updater: 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode',
    });
  });

  test('an unreadable registry names no updater', () => {
    for (const raw of ['{not json', '[]', 'null']) {
      const out = step1({ raw, cache: { omc: ['5.9.0'] } });
      expect(Object.keys(out)).toEqual(['Channel']);
      expect(out.Channel).toContain('unknown');
    }
  });

  test('the skill routes the update and the diagnosis through the derived lines, with no fixed updater recipe left', () => {
    expect(text).not.toMatch(/marketplace update omc/);
    expect(text).not.toMatch(/claude plugin update oh-my-claudecode@omc/);
    expect(text).not.toMatch(/\/omc-setup\b.*\bnpm install\b/);
    const diagnosis = text.slice(text.indexOf('### Step 1'), text.indexOf('### Step 2'));
    expect(diagnosis).toContain('LATEST comes from the install channel the registry records');
    expect(diagnosis).toContain('`npm view` (the `npm latest:` line) is consulted only for `Channel: npm`, so ignore that line for a marketplace install');
    expect(diagnosis).toContain('never compared with an npm-only release');
    expect(diagnosis).toContain('If INSTALLED equals the channel\'s latest, there is no WARN');
    const outdated = text.slice(text.indexOf('### Fix: Outdated Plugin'), text.indexOf('### Fix: Stale Cache'));
    expect(outdated).toContain('run the `Updater:` line that Step 1 printed for the active plugin ID');
    expect(outdated).toContain('do not substitute a fixed marketplace or plugin ID');
    expect(outdated).toContain('`omc update`');
  });
});
