import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCATION_VARS,
  TEST_HOME_PREFIX,
  hostTag,
  isUnderHome,
} from './helpers/home-isolation-global-setup.js';

// #5089: the suite wrote fixture state into the real ~/.omc.
describe('test home isolation', () => {
  // The regression check. It fails when the global setup in vitest.config.ts
  // is missing or stops redirecting the home directory.
  it('runs with a per-run home directory', () => {
    const home = homedir();
    expect(
      basename(home).startsWith(TEST_HOME_PREFIX),
      `os.homedir() is ${home}; expected a ${TEST_HOME_PREFIX}* directory from the global setup`,
    ).toBe(true);
    expect(existsSync(home)).toBe(true);
  });

  it('gives child processes the same home', () => {
    const childHome = execFileSync(process.execPath, ['-p', 'require("node:os").homedir()'], {
      encoding: 'utf8',
    }).trim();
    expect(childHome).toBe(homedir());
  });

  it.each(LOCATION_VARS)('does not inherit %s', (name) => {
    expect(process.env[name]).toBeUndefined();
  });
});

describe('isUnderHome', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(homedir(), 'home-isolation-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sees a checkout below a symlinked home', () => {
    const realHome = join(root, 'real-home');
    const checkout = join(realHome, 'src', 'repo');
    mkdirSync(checkout, { recursive: true });
    const linkedHome = join(root, 'linked-home');
    symlinkSync(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');

    // homedir() reports the link, process.cwd() the real path.
    expect(isUnderHome(linkedHome, checkout)).toBe(true);
    expect(isUnderHome(realHome, checkout)).toBe(true);
  });

  it('rejects a checkout outside the home', () => {
    const home = join(root, 'home');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(home);
    mkdirSync(elsewhere);
    expect(isUnderHome(home, elsewhere)).toBe(false);
    expect(isUnderHome(home, home)).toBe(false);
  });
});

describe('hostTag', () => {
  it('tells apart hosts whose names share a long prefix', () => {
    expect(hostTag('build-runner-pool-a-0001')).not.toBe(hostTag('build-runner-pool-a-0002'));
    expect(hostTag('my.host')).not.toBe(hostTag('myhost'));
  });

  it('is stable and safe in a folder name', () => {
    expect(hostTag('box')).toBe(hostTag('box'));
    expect(hostTag('box')).toMatch(/^[0-9a-f]{16}$/);
  });
});
