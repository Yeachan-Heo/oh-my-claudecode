import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCATION_VARS,
  TEST_HOME_PREFIX,
  findExposedWorkspaceMarker,
  hostTag,
  removeStaleTestHomes,
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

describe('findExposedWorkspaceMarker', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(homedir(), 'home-isolation-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const marker = (dir: string): string => {
    writeFileSync(join(dir, '.omc-workspace'), '');
    return join(dir, '.omc-workspace');
  };

  it('finds a marker in a symlinked home', () => {
    const realHome = join(root, 'real-home');
    const checkout = join(realHome, 'src', 'repo');
    mkdirSync(checkout, { recursive: true });
    const linkedHome = join(root, 'linked-home');
    symlinkSync(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
    const planted = marker(realHome);

    // homedir() reports the link, process.cwd() the real path.
    expect(findExposedWorkspaceMarker(linkedHome, checkout)).toBe(planted);
    expect(findExposedWorkspaceMarker(realHome, checkout)).toBe(planted);
  });

  it('finds a marker above the home', () => {
    const home = join(root, 'home');
    const checkout = join(home, 'repo');
    mkdirSync(checkout, { recursive: true });
    const planted = marker(root);
    expect(findExposedWorkspaceMarker(home, checkout)).toBe(planted);
  });

  it('checks when the checkout is the home itself', () => {
    const home = join(root, 'home');
    mkdirSync(home);
    const planted = marker(home);
    expect(findExposedWorkspaceMarker(home, home)).toBe(planted);
  });

  it('ignores a checkout outside the home, whose walk already reached the root', () => {
    const home = join(root, 'home');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(home);
    mkdirSync(elsewhere);
    marker(home);
    expect(findExposedWorkspaceMarker(home, elsewhere)).toBeNull();
  });

  it('returns null without a marker', () => {
    const home = join(root, 'home');
    const checkout = join(home, 'repo');
    mkdirSync(checkout, { recursive: true });
    expect(findExposedWorkspaceMarker(home, checkout)).toBeNull();
  });
});

describe('removeStaleTestHomes', () => {
  let outer: string;
  beforeEach(() => {
    outer = realpathSync.native(mkdtempSync(join(homedir(), 'home-isolation-stale-')));
  });
  afterEach(() => {
    rmSync(outer, { recursive: true, force: true });
  });

  // A PID that existed and has exited.
  const deadPid = (): number => {
    const { pid } = spawnSync(process.execPath, ['-e', '0']);
    if (pid === undefined) throw new Error('spawnSync returned no pid');
    return pid;
  };

  const home = (name: string): string => {
    const dir = join(outer, name);
    mkdirSync(join(dir, '.omc', 'state'), { recursive: true });
    writeFileSync(join(dir, '.omc', 'state', 'x.json'), '{}');
    return dir;
  };

  it('removes only homes of this host whose process is gone', () => {
    const own = `${TEST_HOME_PREFIX}${hostTag('this-host')}-`;
    const foreign = `${TEST_HOME_PREFIX}${hostTag('other-host')}-`;
    const dead = deadPid();

    const stale = home(`${own}${dead}-a`);
    const live = home(`${own}${process.pid}-b`);
    const otherHost = home(`${foreign}${dead}-c`);
    const unrelated = home(`${own}not-a-pid`);
    const userFolder = home('projects');

    removeStaleTestHomes(outer, own);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(otherHost)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(userFolder)).toBe(true);
  });

  it('does nothing when the home cannot be read', () => {
    expect(() => removeStaleTestHomes(join(outer, 'missing'), `${TEST_HOME_PREFIX}x-`)).not.toThrow();
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
