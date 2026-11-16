/* global process, URL */
// The API key helper: the file, env and command sources of the profile. Key values are fixtures.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile, fakeKeyFile, runNode, PLACEHOLDER_KEY } from './_helpers.mjs';

const HELPER = fileURLToPath(new URL('../../../scripts/provider/provider-key-helper.cjs', import.meta.url));
const LOOPBACK = 'http://127.0.0.1:1';

describe.skipIf(process.platform === 'win32')('provider-key-helper', () => {
  let tmp;
  beforeAll(() => {
    tmp = makeTmp('provider-key-');
  });
  afterAll(() => {
    tmp.cleanup();
  });

  it('(9) with a key file (test seam): prints the key without surrounding whitespace or line end', () => {
    const r = runNode(HELPER, ['--profile', 'acme'], { env: { PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER_BASE_URL: LOOPBACK, OMC_PROVIDER_API_KEY_FILE: fakeKeyFile(join(tmp.dir, 'k9')) } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(PLACEHOLDER_KEY);
  });

  it('(10) missing, empty, whitespace-only, whitespace-inside and directory key sources: exit 1, empty stdout, no key and no path in stderr', () => {
    const dir = join(tmp.dir, 'k10');
    mkdirSync(dir, { recursive: true });
    const whitespace = join(dir, 'whitespace');
    writeFileSync(whitespace, ' \n\t\n');
    const empty = join(dir, 'empty');
    writeFileSync(empty, '');
    const inside = join(dir, 'w-inside');
    writeFileSync(inside, 'part-one part-two\n');
    const folder = join(dir, 'directory');
    mkdirSync(folder);
    const cases = [
      ['missing', join(dir, 'missing')],
      ['empty', empty],
      ['whitespace only', whitespace],
      ['whitespace inside', inside],
      ['directory', folder],
    ];
    for (const [name, file] of cases) {
      const r = runNode(HELPER, ['--profile', 'acme'], { env: { PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER_BASE_URL: LOOPBACK, OMC_PROVIDER_API_KEY_FILE: file } });
      expect(r.status, name).toBe(1);
      expect(r.stdout, name).toBe('');
      expect(r.stderr.includes(dir), name).toBe(false);
      expect(r.stderr.includes('part-one'), name).toBe(false);
    }
  });

  it('key file variable without a loopback base URL (the pair rule): exit 2, no output, no key', () => {
    const dir = join(tmp.dir, 'pair-helper');
    const keyFile = fakeKeyFile(dir);
    const alone = runNode(HELPER, ['--profile', 'acme'], { env: { PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER_API_KEY_FILE: keyFile } });
    expect(alone.status).toBe(2);
    expect(alone.stdout).toBe('');
    expect(alone.stderr.includes(PLACEHOLDER_KEY)).toBe(false);
    const foreign = runNode(HELPER, ['--profile', 'acme'], { env: { PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER_BASE_URL: 'https://api.example.test', OMC_PROVIDER_API_KEY_FILE: keyFile } });
    expect(foreign.status).toBe(2);
    expect(foreign.stdout).toBe('');
  });

  it('reads the key from the profile file source (file)', () => {
    const dir = join(tmp.dir, 'profile-file');
    const { env } = writeProfile(dir);
    const r = runNode(HELPER, ['--profile', 'acme'], { env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(PLACEHOLDER_KEY);
  });

  it('reads the key from the profile env source (named variable)', () => {
    const dir = join(tmp.dir, 'profile-env');
    const { env } = writeProfile(dir, { apiKey: { env: 'ACME_FIXTURE_KEY' } });
    const r = runNode(HELPER, ['--profile', 'acme'], { env: { ...env, ACME_FIXTURE_KEY: PLACEHOLDER_KEY } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(PLACEHOLDER_KEY);
    const none = runNode(HELPER, ['--profile', 'acme'], { env });
    expect(none.status).toBe(1);
    expect(none.stdout).toBe('');
  });

  it('reads the key from the profile command source (no shell, output trimmed)', () => {
    const dir = join(tmp.dir, 'profile-command');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'fixture-key-command');
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${PLACEHOLDER_KEY}'\n`);
    chmodSync(script, 0o755);
    const { env } = writeProfile(dir, { apiKey: { command: script } });
    const r = runNode(HELPER, ['--profile', 'acme'], { env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(PLACEHOLDER_KEY);
  });

  it('a failing key command gives exit 1 without output', () => {
    const dir = join(tmp.dir, 'profile-command-fail');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'failing');
    writeFileSync(script, '#!/bin/sh\nexit 3\n');
    chmodSync(script, 0o755);
    const { env } = writeProfile(dir, { apiKey: { command: script } });
    const r = runNode(HELPER, ['--profile', 'acme'], { env });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('env and command sources: whitespace inside the key is refused, the same rule as for files', () => {
    const dir = join(tmp.dir, 'profile-inside');
    mkdirSync(dir, { recursive: true });
    const { env } = writeProfile(dir, { apiKey: { env: 'ACME_FIXTURE_KEY' } });
    const inside = runNode(HELPER, ['--profile', 'acme'], { env: { ...env, ACME_FIXTURE_KEY: 'part-one part-two' } });
    expect(inside.status).toBe(1);
    expect(inside.stdout).toBe('');
    const script = join(dir, 'inside-command');
    writeFileSync(script, "#!/bin/sh\nprintf '%s' 'part-one part-two'\n");
    chmodSync(script, 0o755);
    const command = writeProfile(join(dir, 'command'), { apiKey: { command: script } });
    const cmd = runNode(HELPER, ['--profile', 'acme'], { env: command.env });
    expect(cmd.status).toBe(1);
    expect(cmd.stdout).toBe('');
  });

  it('key command has a 10 s limit: a slower command is stopped and the helper exits 1', () => {
    const dir = join(tmp.dir, 'profile-slow');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'slow');
    writeFileSync(script, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(script, 0o755);
    const { env } = writeProfile(dir, { apiKey: { command: script } });
    const started = Date.now();
    const r = runNode(HELPER, ['--profile', 'acme'], { env, timeoutMs: 25000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(Date.now() - started).toBeLessThan(25000);
  }, 40000);

  it('without any profile file: exit 2, no output, nothing created under the home directory', () => {
    const dir = join(tmp.dir, 'no-profile');
    mkdirSync(dir, { recursive: true });
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const r = runNode(HELPER, ['--profile', 'acme'], { env: { PATH: process.env.PATH, HOME: home } });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.omc'))).toBe(false);
  });
});
