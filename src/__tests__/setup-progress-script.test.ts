import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'setup-progress.sh');

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('setup-progress.sh', () => {
  it('writes setup completion metadata to CLAUDE_CONFIG_DIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-setup-progress-'));
    tempRoots.push(root);

    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    const configDir = join(root, 'custom-claude');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    const result = spawnSync('bash', [SCRIPT_PATH, 'complete', 'v9.9.9'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);

    const configPath = join(configDir, '.omc-config.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      setupCompleted?: string;
      setupVersion?: string;
    };

    expect(config.setupVersion).toBe('v9.9.9');
    expect(config.setupCompleted).toBeTruthy();
  });

  it('fails without jq and preserves existing setup config', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-setup-progress-no-jq-'));
    tempRoots.push(root);

    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    const configDir = join(root, 'custom-claude');
    const binDir = join(root, 'bin-no-jq');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    for (const command of ['dirname', 'pwd']) {
      symlinkSync(`/usr/bin/${command}`, join(binDir, command));
    }

    const configPath = join(configDir, '.omc-config.json');
    const originalConfig = '{\n  "existing": true\n}\n';
    writeFileSync(configPath, originalConfig);

    const result = spawnSync('/usr/bin/bash', [SCRIPT_PATH, 'complete', 'v9.9.9'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        CLAUDE_CONFIG_DIR: configDir,
        PATH: binDir,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('jq is required');
    expect(readFileSync(configPath, 'utf-8')).toBe(originalConfig);
  });
});
