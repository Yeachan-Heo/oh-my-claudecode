import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';

const RESOLVER = join(process.cwd(), 'skills', 'self-improve', 'scripts', 'resolve-paths.mjs');
const VALIDATE = join(process.cwd(), 'skills', 'self-improve', 'scripts', 'validate.sh');

function readJson(command: string, args: string[]) {
  return JSON.parse(execFileSync(command, args, { encoding: 'utf-8' }));
}

describe('self-improve path scoping helpers', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omc-self-improve-paths-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults new runs to a scoped default topic root', () => {
    const result = readJson('node', [RESOLVER, '--project-root', root]);
    expect(result.topic_slug).toBe('default');
    expect(result.scope_mode).toBe('default-scoped');
    expect(result.root).toBe(join(root, '.omc', 'self-improve', 'topics', 'default'));
  });

  it('uses a slugified topic-specific root when topic text is provided', () => {
    const result = readJson('node', [RESOLVER, '--project-root', root, '--topic', 'Latency & Throughput']);
    expect(result.topic_slug).toBe('latency-throughput');
    expect(result.scope_mode).toBe('topic-scoped');
    expect(result.root).toBe(join(root, '.omc', 'self-improve', 'topics', 'latency-throughput'));
  });

  it('falls back to the legacy flat root when legacy state already exists and no topic is provided', () => {
    const legacyConfigDir = join(root, '.omc', 'self-improve', 'config');
    mkdirSync(legacyConfigDir, { recursive: true });
    writeFileSync(join(legacyConfigDir, 'settings.json'), '{}\n', 'utf-8');

    const result = readJson('node', [RESOLVER, '--project-root', root]);
    expect(result.topic_slug).toBe('default');
    expect(result.scope_mode).toBe('legacy-flat-root');
    expect(result.root).toBe(join(root, '.omc', 'self-improve'));
  });

  it('creates the resolved scoped directories when asked', () => {
    const result = readJson('node', [RESOLVER, '--project-root', root, '--slug', 'perf-track', '--ensure-dirs']);
    expect(existsSync(result.config_dir)).toBe(true);
    expect(existsSync(result.state_dir)).toBe(true);
    expect(existsSync(result.tracking_dir)).toBe(true);
  });

  it('validate.sh auto-discovers a single scoped settings file', () => {
    const scopedConfigDir = join(root, '.omc', 'self-improve', 'topics', 'perf-track', 'config');
    mkdirSync(scopedConfigDir, { recursive: true });
    writeFileSync(join(scopedConfigDir, 'settings.json'), JSON.stringify({ sealed_files: [] }), 'utf-8');

    const output = execFileSync('bash', [VALIDATE], {
      cwd: root,
      encoding: 'utf-8',
    });

    // macOS symlinks both /var and /tmp under /private; validate.sh resolves the
    // real path, so strip a leading /private before either prefix to compare.
    const expectedSettings = normalize(join(scopedConfigDir, 'settings.json')).replace(/^\/private(?=\/(?:var|tmp)\/)/, '');
    const normalizedOutput = normalize(output).replace(/^Settings: \/private(?=\/(?:var|tmp)\/)/m, 'Settings: ');
    expect(normalizedOutput).toContain(`Settings: ${expectedSettings}`);
    expect(output).toContain('All checks passed');
  });

  it('validate.sh errors when multiple scoped topics exist without an explicit selector', () => {
    const configA = join(root, '.omc', 'self-improve', 'topics', 'alpha', 'config');
    const configB = join(root, '.omc', 'self-improve', 'topics', 'beta', 'config');
    mkdirSync(configA, { recursive: true });
    mkdirSync(configB, { recursive: true });
    writeFileSync(join(configA, 'settings.json'), JSON.stringify({ sealed_files: [] }), 'utf-8');
    writeFileSync(join(configB, 'settings.json'), JSON.stringify({ sealed_files: [] }), 'utf-8');

    expect(() => execFileSync('bash', [VALIDATE], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/Multiple self-improve topics exist/);
  });

  it('validate.sh resolves a selected topic via project root and slug', () => {
    const selected = readJson('node', [RESOLVER, '--project-root', root, '--slug', 'alpha', '--ensure-dirs']);
    writeFileSync(selected.settings_path, JSON.stringify({ sealed_files: [] }), 'utf-8');

    const output = execFileSync('bash', [VALIDATE, '--project-root', root, '--slug', 'alpha'], {
      cwd: root,
      encoding: 'utf-8',
    });

    expect(output).toContain(`Settings: ${selected.settings_path}`);
  });

  it('templates/settings.json includes the persisted topic slug field', () => {
    const templatePath = join(process.cwd(), 'skills', 'self-improve', 'templates', 'settings.json');
    const template = JSON.parse(readFileSync(templatePath, 'utf-8')) as { topic_slug?: string };
    expect(template.topic_slug).toBe('default');
  });
});
