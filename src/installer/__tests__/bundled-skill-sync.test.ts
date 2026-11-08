import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAVED_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_ROOT', 'OMC_PLUGIN_ROOT', 'OMC_DEV'] as const;
const ORIG_ENV: Record<(typeof SAVED_ENV_KEYS)[number], string | undefined> = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
  OMC_PLUGIN_ROOT: process.env.OMC_PLUGIN_ROOT,
  OMC_DEV: process.env.OMC_DEV,
};
const COLLIDING_SKILL = 'trace';
const OTHER_SKILL = 'verify';

let configDir: string;

async function freshInstaller() {
  vi.resetModules();
  return await import('../index.js');
}

async function installBundledSkills() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { install } = await freshInstaller();
  const result = install({
    noPlugin: true,
    skipClaudeCheck: true,
    skipHud: true,
    verbose: true,
  });
  return {
    result,
    logs: logSpy.mock.calls.map(([message]) => String(message)).join('\n'),
  };
}

function skillTarget(name: string): string {
  return join(configDir, 'skills', name);
}

function expectCollisionWarning(logs: string, targetDir: string): void {
  expect(logs).toContain(targetDir);
  expect(logs).toContain('user-managed entry');
  expect(logs).toContain('bundled skill was not installed');
  expect(logs).toContain("Remove or rename it to enable OMC's version");
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'omc-bundled-skill-sync-'));
  for (const key of SAVED_ENV_KEYS) {
    delete process.env[key];
  }
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of SAVED_ENV_KEYS) {
    const originalValue = ORIG_ENV[key];
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
  rmSync(configDir, { recursive: true, force: true });
});

describe('install() bundled skill destination collisions', () => {
  it('preserves a symlink-to-directory collision and installs other bundled skills', async () => {
    const targetDir = skillTarget(COLLIDING_SKILL);
    const externalDir = join(configDir, 'external-skill');
    mkdirSync(join(configDir, 'skills'), { recursive: true });
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, 'user-content.txt'), 'user-owned content\n');
    symlinkSync(externalDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir');

    const { result, logs } = await installBundledSkills();

    expect(result.success).toBe(true);
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(targetDir)).toBe(externalDir);
    expect(readFileSync(join(externalDir, 'user-content.txt'), 'utf8')).toBe('user-owned content\n');
    expect(existsSync(join(externalDir, '.omc-managed'))).toBe(false);
    expect(existsSync(join(configDir, 'skills', OTHER_SKILL, 'SKILL.md'))).toBe(true);
    expect(result.installedSkills).not.toContain(`${COLLIDING_SKILL}/SKILL.md`);
    expect(result.installedSkills).toContain(`${OTHER_SKILL}/SKILL.md`);
    expectCollisionWarning(logs, targetDir);
  });

  it('preserves and skips a dangling symlink without aborting installation', async () => {
    const targetDir = skillTarget(COLLIDING_SKILL);
    const danglingTarget = join(configDir, 'missing-skill-target');
    mkdirSync(join(configDir, 'skills'), { recursive: true });
    symlinkSync(danglingTarget, targetDir, process.platform === 'win32' ? 'junction' : 'dir');

    const { result, logs } = await installBundledSkills();

    expect(result.success).toBe(true);
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(targetDir)).toBe(danglingTarget);
    expect(result.installedSkills).not.toContain(`${COLLIDING_SKILL}/SKILL.md`);
    expectCollisionWarning(logs, targetDir);
  });

  it('preserves and skips a regular-file collision', async () => {
    const targetDir = skillTarget(COLLIDING_SKILL);
    const userContent = 'user-owned skill entry\n';
    mkdirSync(join(configDir, 'skills'), { recursive: true });
    writeFileSync(targetDir, userContent);

    const { result, logs } = await installBundledSkills();

    expect(result.success).toBe(true);
    expect(lstatSync(targetDir).isFile()).toBe(true);
    expect(readFileSync(targetDir, 'utf8')).toBe(userContent);
    expect(result.installedSkills).not.toContain(`${COLLIDING_SKILL}/SKILL.md`);
    expectCollisionWarning(logs, targetDir);
  });

  it('force-copies bundled content and writes the marker into an existing real skill directory', async () => {
    const targetDir = skillTarget(COLLIDING_SKILL);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'SKILL.md'), 'stale bundled content\n');
    writeFileSync(join(targetDir, 'stale-user-file.txt'), 'preserved by directory merge\n');

    const { result } = await installBundledSkills();
    const { getRuntimePackageRoot } = await freshInstaller();
    const bundledContent = readFileSync(
      join(getRuntimePackageRoot(), 'skills', COLLIDING_SKILL, 'SKILL.md'),
      'utf8',
    );

    expect(result.success).toBe(true);
    expect(result.installedSkills).toContain(`${COLLIDING_SKILL}/SKILL.md`);
    expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf8')).toBe(bundledContent);
    expect(readFileSync(join(targetDir, '.omc-managed'), 'utf8')).toBe('omc-managed\n');
  });
});
