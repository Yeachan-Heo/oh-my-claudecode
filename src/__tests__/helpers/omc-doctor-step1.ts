import { expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandWith, runCommand, writeCaseFoldPreload, writeRegistry, writeRegistryFile } from './omc-doctor-cache-fixture.js';

// The Step 1 command of the omc-doctor skill (the line that prints Plugin, Channel, Installed, Latest and Updater).
export const versionCommand = commandWith("'Updater: ");

export type Profile = {
  plugins?: Record<string, unknown> | ((dir: string) => Record<string, unknown>);
  platform?: string;
  casefold?: boolean;
  raw?: string;
  cache?: Record<string, string[]>;
  clone?: Record<string, string>;
  env?: (dir: string) => Record<string, string>;
  setup?: (dir: string) => void;
};

// Runs the Step 1 command against a synthetic config directory. `cache` maps a marketplace name to the
// version directories under plugins/cache/<marketplace>/oh-my-claudecode, `clone` maps a marketplace name
// to the plugin version its clone advertises, `env` sets variables (it may create the directories they name)
// and `setup` runs last. The command always runs with a timeout: a read that blocks must show up as an error.
export function step1(profile: Profile) {
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
    else if (profile.plugins) writeRegistry(dir, typeof profile.plugins == 'function' ? profile.plugins(dir) : profile.plugins);
    const preload = path.join(dir, 'platform.cjs');
    if (profile.platform) writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: '${profile.platform}' });\n`);
    profile.setup?.(dir);
    // `casefold` gives the process a volume that ignores letter case while it reports linux (WSL2 on a Windows drive).
    const preloads = [...(profile.platform ? [preload] : []), ...(profile.casefold ? [writeCaseFoldPreload(dir)] : [])];
    const result = runCommand(versionCommand ?? '', dir, { preloads, env: profile.env?.(dir), timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return Object.fromEntries(result.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
