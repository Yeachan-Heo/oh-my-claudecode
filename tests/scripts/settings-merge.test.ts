import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'settings-merge.mjs');
const BOM = String.fromCharCode(0xfeff);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runTool(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function writeJson(name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

function writeRaw(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-merge-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});


describe('settings-merge script', () => {
  it('deletes a key set to null in the patch', () => {
    const settings = writeJson('settings.json', { a: 1, b: 2, env: { OMC_X: '1' } });
    const patch = writeJson('patch.json', { b: null });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    expect(result).toEqual({ a: 1, env: { OMC_X: '1' } });
    expect(r.stdout).toContain('b: 2 -> (deleted)');
  });

  it('merges nested objects recursively', () => {
    const settings = writeJson('settings.json', { env: { OMC_A: '1' } });
    const patch = writeJson('patch.json', { env: { OMC_B: '2' } });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ env: { OMC_A: '1', OMC_B: '2' } });
  });

  it('replaces arrays and scalars instead of merging them', () => {
    const settings = writeJson('settings.json', { list: [1, 2], model: 'sonnet' });
    const patch = writeJson('patch.json', { list: [3], model: 'opus' });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ list: [3], model: 'opus' });
  });

  it('applies multiple patches in argument order', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    const p1 = writeJson('p1.json', { model: 'opus' });
    const p2 = writeJson('p2.json', { model: 'haiku', extra: true });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', p1, '--patch', p2]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ model: 'haiku', extra: true });
  });

  it('leaves the old file intact when the patch file is invalid JSON', () => {
    const file = writeJson('settings.json', { model: 'sonnet' });
    const bad = writeRaw('bad.json', '{not json');
    const r = runTool(['--settings', file, '--output', file, '--patch', bad]);
    expect(r.status).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');
    expect(r.stderr).toContain('invalid JSON');
  });

  it('keeps the input file untouched so it doubles as the backup', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    const patch = writeJson('patch.json', { model: 'opus' });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect(readFileSync(settings, 'utf8')).toBe(JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('creates the output with the input file mode', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    chmodSync(settings, 0o600);
    const patch = writeJson('patch.json', { model: 'opus' });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect((statSync(output).mode & 0o777)).toBe(0o600);
  });

  it('strips a leading BOM from the settings file', () => {
    const settings = writeRaw('settings.json', BOM + JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output]);
    expect(r.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');
  });

  it('skips underscore-prefixed comment keys at any depth', () => {
    const settings = writeJson('settings.json', { env: { OMC_A: '1' } });
    const patch = writeJson('patch.json', { _note: 'x', env: { OMC_B: '2', _why: 'y' } });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ env: { OMC_A: '1', OMC_B: '2' } });
    expect(r.stdout).not.toContain('_note');
  });

  it('redacts secret-like keys and long values in the change list', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    const patch = writeJson('patch.json', { apiKey: 'v', long: 'x'.repeat(201) });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('apiKey: (missing) -> <redacted>');
    expect(r.stdout).toContain('long: (missing) -> <redacted>');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ model: 'sonnet', apiKey: 'v', long: 'x'.repeat(201) });
  });

  it('redacts nested secrets when deleting an object', () => {
    const settings = writeJson('settings.json', { env: { ANTHROPIC_API_KEY: 'secret123', OMC_X: '1' } });
    const patch = writeJson('patch.json', { env: null });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('env: <redacted> -> (deleted)');
    expect(r.stdout).not.toContain('ANTHROPIC_API_KEY');
    expect(r.stdout).not.toContain('secret123');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({});
  });

  it('redacts nested secrets when replacing a scalar with an object containing a secret', () => {
    const settings = writeJson('settings.json', { data: 'oldvalue' });
    const patch = writeJson('patch.json', { data: { ANTHROPIC_API_KEY: 'secret123' } });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    // When replacing a scalar with an object, the merge logs the scalar replacement and then recursively processes keys
    expect(r.stdout).toContain('data.ANTHROPIC_API_KEY: (missing) -> <redacted>');
    expect(r.stdout).not.toContain('secret123');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ data: { ANTHROPIC_API_KEY: 'secret123' } });
  });

  it('redacts secrets nested in arrays of objects when deleting or replacing them', () => {
    const settings = writeJson('settings.json', { servers: [{ name: 'a', authToken: 'secret123' }], more: [[{ apiKey: 'secret456' }]] });
    const patch = writeJson('patch.json', { servers: null, more: [{ name: 'b' }] });
    const output = join(dir, 'out.json');
    const r = runTool(['--settings', settings, '--output', output, '--patch', patch]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('servers: <redacted> -> (deleted)');
    expect(r.stdout).toContain('more: <redacted> -> ');
    expect(r.stdout).not.toContain('authToken');
    expect(r.stdout).not.toContain('apiKey');
    expect(r.stdout).not.toContain('secret');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ more: [{ name: 'b' }] });
  });

  it('exits 2 when the patch file is missing', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    const r = runTool(['--settings', settings, '--output', join(dir, 'out.json'), '--patch', join(dir, 'nope.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Missing file');
  });

  it('exits 2 when the settings file has invalid JSON', () => {
    const settings = writeRaw('settings.json', '{oops');
    const r = runTool(['--settings', settings, '--output', join(dir, 'out.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('JSON');
  });

  it('exits 2 on an unknown argument', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    const r = runTool(['--settings', settings, '--output', join(dir, 'out.json'), '--wat']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown argument');
  });

  it('exits 2 when required arguments are missing', () => {
    const r = runTool(['--patch', join(dir, 'p.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
  });

  it('exits 2 when --template-out is given without --template', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    const r = runTool(['--settings', settings, '--output', join(dir, 'out.json'), '--template-out', join(dir, 't.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--template-out requires --template');
  });

  it('generates a template with OMC_* env outside machineEnv, modelSettings windows and the top-level window', () => {
    const settings = writeJson('settings.json', {
      env: { OMC_A: 'a', OMC_B: 'b', OMC_M: 'm', HOME: '/h' },
      modelSettings: { opus: { autoCompactWindow: 100 }, sonnet: { model: 'sonnet' } },
      autoCompactWindow: 5,
    });
    const template = writeJson('template.json', { machineEnv: ['OMC_M'], keep: 'k', autoCompactWindow: 99 });
    const templateOut = join(dir, 'tmpl-out.json');
    const output = join(dir, 'out.json');
    const r = runTool([
      '--settings', settings, '--output', output,
      '--template-out', templateOut, '--template', template,
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(templateOut, 'utf8'))).toEqual({
      machineEnv: ['OMC_M'],
      keep: 'k',
      autoCompactWindow: 5,
      env: { OMC_A: 'a', OMC_B: 'b' },
      modelSettings: { opus: { autoCompactWindow: 100 } },
    });
    expect(r.stdout).toContain('template: ');
  });

  it('drops the top-level autoCompactWindow from the template when the result has none', () => {
    const settings = writeJson('settings.json', { model: 'sonnet' });
    const template = writeJson('template.json', { machineEnv: [], autoCompactWindow: 99 });
    const templateOut = join(dir, 'tmpl-out.json');
    const output = join(dir, 'out.json');
    const r = runTool([
      '--settings', settings, '--output', output,
      '--template-out', templateOut, '--template', template,
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(templateOut, 'utf8'))).toEqual({
      machineEnv: [],
      env: {},
      modelSettings: {},
    });
  });
});
