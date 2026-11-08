import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildCapabilitiesLockfile,
  capabilitiesCheckCommand,
  capabilitiesLockCommand,
  runDeterministicCapabilityFixtures,
  skillNameFromSkillFilePath,
  type CapabilitiesLockfile,
} from '../capabilities.js';

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omc-capabilities-'));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn(cwd);
  } finally {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('capabilities lock/check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('writes a deterministic lockfile and checks it successfully', async () => {
    await withTempCwd(async (cwd) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const lockfile = join(cwd, 'capabilities.lock.json');

      await expect(capabilitiesLockCommand({ json: true, lockfile })).resolves.toBe(0);
      await expect(capabilitiesCheckCommand({ json: true, lockfile })).resolves.toBe(0);

      const written = JSON.parse(await readFile(lockfile, 'utf-8')) as CapabilitiesLockfile;
      expect(written.schemaVersion).toBe('1.0');
      expect(written.surfaceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(written.surface.contract).toMatchObject({
        runner: 'deterministic-local',
        liveProbeCompatible: true,
      });
      expect(written.fixtureResults.every((result) => result.ok)).toBe(true);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  it('returns a machine-readable failure for a missing lockfile', async () => {
    await withTempCwd(async (cwd) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const exitCode = await capabilitiesCheckCommand({ json: true, lockfile: join(cwd, 'missing.json') });

      expect(exitCode).toBe(1);
      const report = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(report.ok).toBe(false);
      expect(report.failures[0].code).toBe('lockfile_missing');
    });
  });

  it('checks required-arg, hallucinated-tool, and no-tool restraint fixtures', () => {
    const lockfile = buildCapabilitiesLockfile();
    const results = runDeterministicCapabilityFixtures(lockfile.fixtures, lockfile.surface);

    expect(results.find((result) => result.kind === 'required_args')).toMatchObject({ ok: true, outcome: 'pass' });
    expect(results.find((result) => result.kind === 'no_hallucinated_tool')).toMatchObject({ ok: true, outcome: 'pass' });
    expect(results.find((result) => result.kind === 'tool_restraint')).toMatchObject({ ok: true, outcome: 'pass' });
  });

  it('fails check when the locked surface body is mutated without updating the digest', async () => {
    await withTempCwd(async (cwd) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const lockfilePath = join(cwd, 'capabilities.lock.json');
      const lockfile = buildCapabilitiesLockfile();
      lockfile.surface.schemaVersion = 'tampered';
      await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

      const exitCode = await capabilitiesCheckCommand({ json: true, lockfile: lockfilePath });

      expect(exitCode).toBe(1);
      const report = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(report.ok).toBe(false);
      expect(report.failures).toContainEqual(expect.objectContaining({
        code: 'lockfile_surface_digest_mismatch',
        expected: lockfile.surfaceDigest,
        actual: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
    });
  });

  it('extracts skill names from win32-style SKILL.md paths without leaking parent paths', () => {
    expect(skillNameFromSkillFilePath('C:\\repo\\skills\\deep-interview\\SKILL.md')).toBe('deep-interview');
    expect(skillNameFromSkillFilePath('C:\\repo\\skills\\nested.skill\\SKILL.md')).toBe('nested.skill');
  });

  it('fails check when the locked deterministic surface digest regresses', async () => {
    await withTempCwd(async (cwd) => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const lockfilePath = join(cwd, 'capabilities.lock.json');
      const lockfile = buildCapabilitiesLockfile();
      lockfile.surfaceDigest = '0'.repeat(64);
      await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

      const exitCode = await capabilitiesCheckCommand({ lockfile: lockfilePath });

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('surface_digest_mismatch');
    });
  });
});
