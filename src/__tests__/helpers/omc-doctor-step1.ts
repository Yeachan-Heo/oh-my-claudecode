import { expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand, STEP1, writeCaseFoldPreload, writeRegistry, writeRegistryFile } from './omc-doctor-cache-fixture.js';

// The Step 1 command of the omc-doctor script (the one that prints Plugin, Channel, Installed, Latest and Updater).
export const versionCommand = STEP1;

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
// The answer is one block of `Key: value` lines. A registry with several plugin IDs prints one block each; step1()
// refuses to fold them into one object (a repeated key would silently keep the last block only), so a test that
// expects several blocks reads them with step1Blocks().
export function step1(profile: Profile) {
  const blocks = step1Blocks(profile);
  if (blocks.length !== 1) throw new Error(`step1() expects one block, the command printed ${blocks.length}: use step1Blocks()`);
  return blocks[0];
}

// The blocks of the answer, one object per plugin (a block starts at its `Plugin:` line; the answers without one,
// unknown, plugin-dir and npm, are a single block).
export function step1Blocks(profile: Profile) {
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
    const result = runCommand(versionCommand, dir, { preloads, env: profile.env?.(dir), timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const blocks: Array<Record<string, string>> = [];
    for (const line of result.stdout.trim().split('\n')) {
      const key = line.slice(0, line.indexOf(': '));
      if (key === 'Plugin' || !blocks.length) blocks.push({});
      const block = blocks[blocks.length - 1];
      // A key twice in one block is a bug of the command, not something to fold.
      if (key in block) throw new Error(`the key ${key} is printed twice in one block: ${result.stdout}`);
      block[key] = line.slice(line.indexOf(': ') + 2);
    }
    return blocks;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
