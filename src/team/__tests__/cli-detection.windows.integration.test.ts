import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { probeCli } from '../cli-detection.js';

const isWindows = process.platform === 'win32';

function canonicalWindowsPath(value: string): string {
  return realpathSync.native(value).toLowerCase();
}

describe.skipIf(!isWindows)('cli-detection native Windows integration', () => {
  let fixtureRoot: string | undefined;
  let originalPath: string | undefined;
  let originalComspec: string | undefined;
  let originalCOMSPEC: string | undefined;
  let sentinelPath: string | undefined;
  let originalSentinelEnv: string | undefined;


  beforeEach(() => {
    originalPath = process.env.PATH;
    originalComspec = process.env.ComSpec;
    originalCOMSPEC = process.env.COMSPEC;
    originalSentinelEnv = process.env.OMC_CLI_DETECTION_EXPECTED_LAUNCH;
    fixtureRoot = mkdtempSync(join(tmpdir(), 'omc cli detection '));
    sentinelPath = join(fixtureRoot, 'injected-side-effect.txt');
    process.env.PATH = `${fixtureRoot}${delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalComspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComspec;
    if (originalCOMSPEC === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = originalCOMSPEC;
    if (originalSentinelEnv === undefined) delete process.env.OMC_CLI_DETECTION_EXPECTED_LAUNCH;
    else process.env.OMC_CLI_DETECTION_EXPECTED_LAUNCH = originalSentinelEnv;
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
    sentinelPath = undefined;
  });

  it('resolves a temporary .exe through where.exe and PATHEXT', () => {
    const exePath = join(fixtureRoot!, 'omc-native-exe.exe');
    copyFileSync(process.execPath, exePath);

    const result = probeCli('omc-native-exe');

    expect(result.found).toBe(true);
    expect(result.path).toBeDefined();
    expect(canonicalWindowsPath(result.path!)).toBe(canonicalWindowsPath(exePath));
    expect(result.version).toBeDefined();
  });

  it('chooses the first absolute where.exe result and preserves spaces in a safe batch path', () => {
    const first = join(fixtureRoot!, 'first');
    const second = join(fixtureRoot!, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    copyFileSync(process.execPath, join(first, 'omc-multi.exe'));
    copyFileSync(process.execPath, join(second, 'omc-multi.exe'));

    const safeBatch = join(fixtureRoot!, 'safe-provider.cmd');
    writeFileSync(
      safeBatch,
      [
        '@echo off',
        'if /i not "%~1"=="--version" exit /b 17',
        '>>"%OMC_CLI_DETECTION_EXPECTED_LAUNCH%" echo expected-launch',
        'echo safe-provider 1.0.0',
        '',
      ].join('\r\n'),
      'utf8',
    );
    process.env.OMC_CLI_DETECTION_EXPECTED_LAUNCH = join(fixtureRoot!, 'expected-launch.txt');
    process.env.PATH = `${fixtureRoot!}${delimiter}${first}${delimiter}${second}${delimiter}${originalPath ?? ''}`;

    const multi = probeCli('omc-multi');
    expect(multi.found).toBe(true);
    expect(multi.path).toBeDefined();
    expect(canonicalWindowsPath(multi.path!)).toBe(canonicalWindowsPath(join(first, 'omc-multi.exe')));

    const safe = probeCli('safe-provider');
    expect(safe).toMatchObject({ found: true, version: 'safe-provider 1.0.0' });
    expect(safe.path).toBeDefined();
    expect(canonicalWindowsPath(safe.path!)).toBe(canonicalWindowsPath(safeBatch));
    const launches = readFileSync(process.env.OMC_CLI_DETECTION_EXPECTED_LAUNCH!, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    expect(launches).toEqual(['expected-launch']);
  });

  it('never invokes unsafe legal metacharacter batch paths or creates the sentinel', () => {
    process.env.OMC_CLI_DETECTION_EXPECTED_LAUNCH = sentinelPath!;

    for (const character of ['%', '!', '^', '&', '(', ')']) {
      const unsafeDir = join(fixtureRoot!, `unsafe${character}dir`);
      mkdirSync(unsafeDir, { recursive: true });
      const unsafeBatch = join(unsafeDir, 'omc-unsafe.cmd');
      writeFileSync(
        unsafeBatch,
        [
          '@echo off',
          '>>"%OMC_CLI_DETECTION_EXPECTED_LAUNCH%" echo injected',
          'echo should-not-run',
          '',
        ].join('\r\n'),
        'utf8',
      );
      rmSync(sentinelPath!, { force: true });
      process.env.PATH = `${unsafeDir}${delimiter}${originalPath ?? ''}`;

      const result = probeCli('omc-unsafe');
      expect(result).toMatchObject({
        found: true,
        error: 'version probe skipped: batch path is not literal-safe',
      });
      expect(result.path).toBeDefined();
      expect(canonicalWindowsPath(result.path!)).toBe(canonicalWindowsPath(unsafeBatch));
      expect(existsSync(sentinelPath!)).toBe(false);
    }
  });

  it('does not execute unsafe candidate names or create an injection sentinel', () => {
    const unsafeNames = ['unsafe%provider', 'unsafe!provider', 'unsafe^provider', 'unsafe&provider', 'unsafe|provider', 'unsafe<provider', 'unsafe>provider', 'unsafe(provider)', 'unsafe"provider', 'unsafe\nprovider'];

    for (const binary of unsafeNames) {
      expect(probeCli(binary)).toEqual({ found: false, error: 'invalid CLI name' });
    }
    expect(existsSync(sentinelPath!)).toBe(false);
  });
});
