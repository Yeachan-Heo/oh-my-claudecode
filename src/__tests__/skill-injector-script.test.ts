import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'skill-injector.mjs');
const NODE = process.execPath;
const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function runSkillInjector(env: NodeJS.ProcessEnv = {}, payload: Record<string, unknown> = {}) {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : makeTempDir('skill-injector-guard-');
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    cwd,
    encoding: 'utf-8',
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      session_id: 'skill-injector-guard',
      prompt: 'ordinary prompt',
      ...payload,
    }),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DISABLE_OMC: '',
      OMC_SKIP_HOOKS: '',
      ...env,
    },
    timeout: 15000,
  });
  return JSON.parse(raw.trim()) as { continue: boolean; suppressOutput?: boolean; hookSpecificOutput?: { additionalContext: string } };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('skill-injector.mjs early disable guard', () => {
  it.each([
    ['DISABLE_OMC=1', { DISABLE_OMC: '1' }],
    ['DISABLE_OMC=true', { DISABLE_OMC: 'true' }],
    ['a trimmed skill-injector skip token', { OMC_SKIP_HOOKS: ' keyword-detector , skill-injector ' }],
  ])('does not load the bridge for %s', (_label, guardEnv) => {
    const projectDir = makeTempDir('skill-injector-guard-project-');
    const poisonDir = makeTempDir('skill-injector-poison-');
    const sentinel = join(poisonDir, 'bridge-loaded');
    const poisonPath = join(poisonDir, 'poison-bridge.cjs');
    writeFileSync(poisonPath, `
const Module = require('module');
const fs = require('fs');
const originalLoad = Module._load;
const originalReaddirSync = fs.readdirSync;
const originalMkdirSync = fs.mkdirSync;
const originalOpenSync = fs.openSync;
const projectDir = ${JSON.stringify(projectDir)}.replaceAll('\\\\', '/');
function normalizedPath(value) { return typeof value === 'string' ? value.replaceAll('\\\\', '/') : ''; }
function isSkillDiscoveryPath(value) {
  const path = normalizedPath(value);
  return path === projectDir + '/.omc/skills' || path.includes('/.omc/skills/') || path.endsWith('/skills/omc-learned');
}
function isSkillStatePath(value) {
  const path = normalizedPath(value);
  return path.startsWith(projectDir + '/.omc/state/') && /skill-sessions-fallback(?:-state)?\\.json(?:\\.lock)?$/.test(path);
}
function mark(name) { require('fs').writeFileSync(${JSON.stringify(sentinel)} + '-' + name, 'called'); }
fs.readdirSync = function(...args) { if (isSkillDiscoveryPath(args[0])) mark('discovery'); return originalReaddirSync.apply(this, args); };
fs.mkdirSync = function(...args) { if (isSkillStatePath(args[0])) mark('state'); return originalMkdirSync.apply(this, args); };
fs.openSync = function(...args) { if (isSkillStatePath(args[0])) mark('state'); return originalOpenSync.apply(this, args); };
Module._load = function(request, parent, isMain) {
  if (request.includes('skill-bridge.cjs')) mark('bridge');
  return originalLoad.apply(this, arguments);
};
`);

    const output = runSkillInjector({
      ...guardEnv,
      NODE_OPTIONS: `--require=${poisonPath}`,
    });

    expect(output).toEqual({ continue: true });
    expect(existsSync(`${sentinel}-bridge`)).toBe(false);
    expect(existsSync(`${sentinel}-discovery`)).toBe(false);
    expect(existsSync(`${sentinel}-state`)).toBe(false);
  });

  it('does not treat unrelated skip tokens or non-exact global values as disabled', () => {
    const output = runSkillInjector({
      DISABLE_OMC: 'TRUE',
      OMC_SKIP_HOOKS: 'keyword-detector',
    });

    expect(output.continue).toBe(true);
    expect(output.suppressOutput).toBe(true);
  });
});

describe('skill-injector.mjs learned skill injection', () => {
  function writeLearnedSkill(projectDir: string) {
    mkdirSync(join(projectDir, '.omc', 'skills'), { recursive: true });
    writeFileSync(join(projectDir, '.omc', 'skills', 'release-notes.md'), `---
name: Release Notes
triggers:
  - release notes
---
Write concise release notes.`);
  }

  it('injects a matching learned skill when invoked directly', () => {
    const projectDir = makeTempDir('skill-injector-learned-');
    writeLearnedSkill(projectDir);

    const output = runSkillInjector({}, {
      cwd: projectDir,
      session_id: 'direct-learned-skill',
      prompt: 'Please prepare release notes.',
    });

    expect(output.hookSpecificOutput?.additionalContext).toContain('### Release Notes (project)');
  });

  it('injects a matching learned skill through the trusted run.cjs Worker path', () => {
    const projectDir = makeTempDir('skill-injector-worker-project-');
    const pluginRoot = makeTempDir('skill-injector-worker-plugin-');
    const scriptsDir = join(pluginRoot, 'scripts');
    const libDir = join(scriptsDir, 'lib');
    mkdirSync(libDir, { recursive: true });
    mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
    for (const file of ['config-dir.mjs', 'stdin.mjs', 'atomic-write.mjs']) {
      writeFileSync(join(libDir, file), readFileSync(join(process.cwd(), 'scripts', 'lib', file)));
    }
    writeFileSync(join(scriptsDir, 'run.cjs'), readFileSync(join(process.cwd(), 'scripts', 'run.cjs')));
    writeFileSync(join(scriptsDir, 'skill-injector.mjs'), readFileSync(SCRIPT_PATH));
    writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{
          type: 'command',
          command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/skill-injector.mjs',
          timeout: 15,
        }] }],
      },
    }));
    writeLearnedSkill(projectDir);

    const result = spawnSync(NODE, [join(scriptsDir, 'run.cjs'), join(scriptsDir, 'skill-injector.mjs')], {
      cwd: projectDir,
      encoding: 'utf-8',
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: projectDir,
        session_id: 'worker-learned-skill',
        prompt: 'Please prepare release notes.',
      }),
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, DISABLE_OMC: '', OMC_SKIP_HOOKS: '' },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('### Release Notes (project)');
  });
});
