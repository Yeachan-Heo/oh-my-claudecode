import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCATION_VARS, TEST_HOME_PREFIX } from './helpers/home-isolation-global-setup.js';

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
