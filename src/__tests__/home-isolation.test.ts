import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FOREIGN_HOME_MAX_AGE_MS,
  LOCATION_VARS,
  TEST_HOME_PREFIX,
  findExposedWorkspaceMarker,
  hostTag,
  isInside,
  pidScope,
  removeStaleTestHomes,
  startHomeHeartbeat,
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

  // Pinned here so that dropping a variable from LOCATION_VARS fails a test
  // instead of silently shrinking the list below.
  const PINNED_LOCATION_VARS = [
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_MCP_CONFIG_PATH',
    'OMC_STATE_DIR',
    'OMC_HOME',
    'OMC_MCP_REGISTRY_PATH',
    'OMC_JOBS_DIR',
    'CODEX_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'CLAUDE_ENV_FILE',
    'OMC_JEV_LOG_DIR',
    'OMC_JEV_BREAKER_DIR',
  ];

  it('unsets at least the pinned location variables', () => {
    expect([...LOCATION_VARS]).toEqual(expect.arrayContaining(PINNED_LOCATION_VARS));
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

  // findWorkspaceRoot() ignores every marker then, so none can anchor state.
  it('returns null when OMC_DISABLE_MULTIREPO is set', () => {
    const home = join(root, 'home');
    const checkout = join(home, 'repo');
    mkdirSync(checkout, { recursive: true });
    const planted = marker(home);
    expect(findExposedWorkspaceMarker(home, checkout, { OMC_DISABLE_MULTIREPO: '1' })).toBeNull();
    expect(findExposedWorkspaceMarker(home, checkout, { OMC_DISABLE_MULTIREPO: '0' })).toBe(planted);
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

  // After a reboot or hostname change the prefix differs, so earlier leftovers
  // can only be told apart by age.
  it('removes a home from another PID scope once it is old enough', () => {
    const own = `${TEST_HOME_PREFIX}${hostTag('this-host')}-`;
    const foreign = `${TEST_HOME_PREFIX}${hostTag('before-reboot')}-`;
    const old = home(`${foreign}${process.pid}-old`);
    const recent = home(`${foreign}${process.pid}-recent`);
    const oldUnrelated = home(`${TEST_HOME_PREFIX}not-ours`);
    const longAgo = new Date(Date.now() - FOREIGN_HOME_MAX_AGE_MS - 60_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(oldUnrelated, longAgo, longAgo);

    removeStaleTestHomes(outer, own);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(oldUnrelated)).toBe(true);
  });

  // An idle watch-mode run creates no fixture folders, so without the
  // heartbeat its home would look a week old to another PID scope.
  it('keeps a live run home fresh with the heartbeat', async () => {
    const live = home(`${TEST_HOME_PREFIX}${hostTag('other-host')}-${process.pid}-live`);
    const longAgo = new Date(Date.now() - FOREIGN_HOME_MAX_AGE_MS - 60_000);
    utimesSync(live, longAgo, longAgo);
    const stop = startHomeHeartbeat(live, 10);
    try {
      await new Promise((done) => setTimeout(done, 100));
    } finally {
      stop();
    }

    removeStaleTestHomes(outer, `${TEST_HOME_PREFIX}${hostTag('this-host')}-`);

    expect(existsSync(live)).toBe(true);
    expect(Date.now() - statSync(live).mtimeMs).toBeLessThan(FOREIGN_HOME_MAX_AGE_MS);
  });

  it('does nothing when the home cannot be read', () => {
    expect(() => removeStaleTestHomes(join(outer, 'missing'), `${TEST_HOME_PREFIX}x-`)).not.toThrow();
  });
});

describe('isInside', () => {
  it('treats a child whose name starts with two dots as inside', () => {
    expect(isInside(join(sep, 'home', 'me'), join(sep, 'home', 'me', '..work', 'repo'))).toBe(true);
    expect(isInside(join(sep, 'home', 'me'), join(sep, 'home', 'me', '..'))).toBe(false);
    expect(isInside(join(sep, 'home', 'me'), join(sep, 'home', 'other'))).toBe(false);
    expect(isInside(join(sep, 'home', 'me'), join(sep, 'home', 'me'))).toBe(false);
  });

  it('finds a marker in the home for a checkout under a two-dot folder', () => {
    const root = realpathSync.native(mkdtempSync(join(homedir(), 'home-isolation-dots-')));
    try {
      const home = join(root, 'home');
      const checkout = join(home, '..work', 'repo');
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(home, '.omc-workspace'), '');
      expect(findExposedWorkspaceMarker(home, checkout)).toBe(join(home, '.omc-workspace'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pidScope', () => {
  it('includes the hostname', () => {
    expect(pidScope('host-a')).not.toBe(pidScope('host-b'));
    expect(pidScope('host-a')).toBe(pidScope('host-a'));
  });

  // Containers that share a home and a hostname still get different prefixes.
  const procfs = ((): boolean => {
    try {
      readlinkSync('/proc/self/ns/pid');
      return true;
    } catch {
      return false;
    }
  })();
  it.runIf(procfs)('includes the PID namespace when procfs is readable', () => {
    expect(pidScope('host-a')).toContain(readlinkSync('/proc/self/ns/pid'));
  });

  // A chroot or hardened container without a readable /proc.
  it('falls back to the hostname without procfs', () => {
    expect(pidScope('host-a', join(sep, 'no-such-proc'))).toBe('host-a\0\0');
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
