import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = join(REPO, 'tools', 'maintenance', 'settings_drift.mjs');

const dir = mkdtempSync(join(tmpdir(), 'settings-drift-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const template = {
  env: { OMC_ALPHA: 'on', OMC_BETA: '1', OMC_TOKEN_X: 'secret-template-value' },
  machine_specific: ['OMC_LOG_DIR'],
  modelSettings: { 'model-a': { autoCompactWindow: 1000000 } },
  no_top_level_autoCompactWindow: true,
  forbidden_env: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'],
};
const templateFile = join(dir, 'template.json');
writeFileSync(templateFile, JSON.stringify(template));
const templateNoMachine = join(dir, 'template-no-machine.json');
writeFileSync(templateNoMachine, JSON.stringify({ ...template, machine_specific: ['OMC_PRIVATE_PATHS'] }));
const templateMachineInTemplate = join(dir, 'template-machine-in-template.json');
writeFileSync(templateMachineInTemplate, JSON.stringify({ ...template, env: { ...template.env, OMC_LOG_DIR: '/expected/path' }, machine_specific: ['OMC_LOG_DIR'] }));

function settingsFile(name: string, env: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ env, modelSettings: template.modelSettings, ...extra }));
  return file;
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'no-such-config') } });
  return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

describe('settings_drift.mjs', () => {
  it('a machine-specific key given only by the option is checked for presence and its value is not printed', () => {
    const env = { ...template.env, OMC_LOG_DIR: '/synthetic/log', OMC_PRIVATE_PATHS: '/synthetic/private' };
    const r = run(['--settings', settingsFile('ok.json', env), '--template', templateNoMachine, '--machine-specific', 'OMC_LOG_DIR']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('differences: 0');
    expect(r.out).not.toContain('/synthetic/');
  });

  it('a machine-specific key in both template and machine_specific list: presence checked, value not compared or printed', () => {
    // Template expects OMC_LOG_DIR = '/expected/path', but settings has '/different/path'
    // Because OMC_LOG_DIR is machine-specific, the difference should not be reported and the value should not be printed
    const env = { ...template.env, OMC_LOG_DIR: '/different/path' };
    const r = run(['--settings', settingsFile('machine-in-template.json', env), '--template', templateMachineInTemplate]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('differences: 0');
    expect(r.out).not.toContain('/different/path');
    expect(r.out).not.toContain('/expected/path');
  });

  it('a machine-specific key in the template that is missing from settings is reported once, without the template value', () => {
    // the settings carry every template key except OMC_LOG_DIR, which the template also lists as machine-specific
    const r = run(['--settings', settingsFile('machine-missing.json', { ...template.env }), '--template', templateMachineInTemplate]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('differences: 1');
    expect(r.stdout.match(/DIFFERENCE env OMC_LOG_DIR/g)).toHaveLength(1);
    expect(r.out).not.toContain('/expected/path');
  });

  it('settings that match the template and carry the machine-specific variable: no differences, exit 0', () => {
    const env = { ...template.env, OMC_LOG_DIR: '/synthetic/log' };
    const r = run(['--settings', settingsFile('ok2.json', env), '--template', templateFile]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('differences: 0');
  });

  it('a missing machine-specific variable is a difference, exit 1', () => {
    const r = run(['--settings', settingsFile('no-log.json', { ...template.env }), '--template', templateFile]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('env OMC_LOG_DIR: missing in settings (machine-specific variable');
  });

  it('reports changed, extra, forbidden and top-level values; hides secret-looking values', () => {
    const env = { OMC_ALPHA: 'off', OMC_TOKEN_X: 'different-secret', OMC_EXTRA: '1', OMC_LOG_DIR: '/synthetic/log', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '5' };
    const file = settingsFile('drift.json', env, { autoCompactWindow: 123, modelSettings: { 'model-a': { autoCompactWindow: 5 } } });
    const r = run(['--settings', file, '--template', templateFile]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('env OMC_ALPHA: settings "off", template "on"');
    expect(r.stdout).toContain('env OMC_BETA: missing in settings');
    expect(r.stdout).toContain('env OMC_EXTRA: present in settings ("1"), not in the template');
    expect(r.stdout).toContain('env CLAUDE_CODE_AUTO_COMPACT_WINDOW: set in settings');
    expect(r.stdout).toContain('modelSettings.model-a.autoCompactWindow: settings 5, template 1000000');
    expect(r.stdout).toContain('autoCompactWindow (top level): 123');
    expect(r.stdout).toContain('env OMC_TOKEN_X: settings <hidden>, template <hidden>');
    expect(r.out).not.toContain('secret');
    expect(r.out).not.toContain('/synthetic/');
  });

  it('usage errors exit 2: no template, missing value, unknown option, missing or bad files', () => {
    const settings = settingsFile('u.json', {});
    expect(run(['--settings', settings]).status).toBe(2);
    expect(run(['--settings', settings, '--template']).status).toBe(2);
    expect(run(['--bogus']).status).toBe(2);
    expect(run(['--settings', join(dir, 'missing.json'), '--template', templateFile]).status).toBe(2);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(run(['--settings', bad, '--template', templateFile]).status).toBe(2);
    expect(run(['--help']).status).toBe(0);
  });
});
