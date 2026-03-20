import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../team/model-contract.js', () => ({
  isCliAvailable: (agentType: string) => agentType === 'codex',
}));

const originalCwd = process.cwd();
const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const originalPath = process.env.PATH;
let tempConfigDir: string;
let tempProjectDir: string;

async function loadExecutor() {
  vi.resetModules();
  return import('../hooks/auto-slash-command/executor.js');
}

describe('auto slash aliases + skill guidance', () => {
  beforeEach(() => {
    tempConfigDir = join(tmpdir(), `omc-auto-slash-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempProjectDir = join(tmpdir(), `omc-auto-slash-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempConfigDir, { recursive: true });
    mkdirSync(tempProjectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir;
    process.chdir(tempProjectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempConfigDir, { recursive: true, force: true });
    rmSync(tempProjectDir, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
    if (originalPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  it('renders provider-aware execution recommendations for deep-interview when codex is available', async () => {
    mkdirSync(join(tempConfigDir, 'skills', 'deep-interview'), { recursive: true });
    writeFileSync(
      join(tempConfigDir, 'skills', 'deep-interview', 'SKILL.md'),
      `---
name: deep-interview
description: Deep interview
---

Deep interview body`
    );

    const { executeSlashCommand } = await loadExecutor();
    const result = executeSlashCommand({
      command: 'deep-interview',
      args: 'improve onboarding',
      raw: '/deep-interview improve onboarding',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('## Provider-Aware Execution Recommendations');
    expect(result.replacementText).toContain('/ralplan --architect codex');
    expect(result.replacementText).toContain('/ralph --critic codex');
  });

  it('renders skill pipeline guidance for slash-loaded skills with handoff metadata', async () => {
    mkdirSync(join(tempConfigDir, 'skills', 'deep-interview'), { recursive: true });
    writeFileSync(
      join(tempConfigDir, 'skills', 'deep-interview', 'SKILL.md'),
      `---
name: deep-interview
description: Deep interview
pipeline: [deep-interview, omc-plan, autopilot]
next-skill: omc-plan
next-skill-args: --consensus --direct
handoff: .omc/specs/deep-interview-{slug}.md
---

Deep interview body`
    );

    const { executeSlashCommand } = await loadExecutor();
    const result = executeSlashCommand({
      command: 'deep-interview',
      args: 'improve onboarding',
      raw: '/deep-interview improve onboarding',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('## Skill Pipeline');
    expect(result.replacementText).toContain('Pipeline: `deep-interview → omc-plan → autopilot`');
    expect(result.replacementText).toContain('Next skill arguments: `--consensus --direct`');
    expect(result.replacementText).toContain('Skill("oh-my-claudecode:omc-plan")');
    expect(result.replacementText).toContain('`.omc/specs/deep-interview-{slug}.md`');
  });

  it('discovers project-local compatibility skills from .agents/skills', async () => {
    mkdirSync(join(tempProjectDir, '.agents', 'skills', 'compat-skill', 'templates'), { recursive: true });
    writeFileSync(
      join(tempProjectDir, '.agents', 'skills', 'compat-skill', 'SKILL.md'),
      `---
name: compat-skill
description: Compatibility skill
---

Compatibility body`
    );
    writeFileSync(
      join(tempProjectDir, '.agents', 'skills', 'compat-skill', 'templates', 'example.txt'),
      'example'
    );

    const { findCommand, executeSlashCommand, listAvailableCommands } = await loadExecutor();

    expect(findCommand('compat-skill')?.scope).toBe('skill');
    expect(listAvailableCommands().some((command) => command.name === 'compat-skill')).toBe(true);

    const result = executeSlashCommand({
      command: 'compat-skill',
      args: '',
      raw: '/compat-skill',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('## Skill Resources');
    expect(result.replacementText).toContain('.agents/skills/compat-skill');
    expect(result.replacementText).toContain('`templates/`');
  });

  it('renders deterministic autoresearch bridge guidance for deep-interview autoresearch mode', async () => {
    mkdirSync(join(tempConfigDir, 'skills', 'deep-interview'), { recursive: true });
    writeFileSync(
      join(tempConfigDir, 'skills', 'deep-interview', 'SKILL.md'),
      `---
name: deep-interview
description: Deep interview
pipeline: [deep-interview, omc-plan, autopilot]
next-skill: omc-plan
next-skill-args: --consensus --direct
handoff: .omc/specs/deep-interview-{slug}.md
---

Deep interview body`
    );

    const { executeSlashCommand } = await loadExecutor();
    const result = executeSlashCommand({
      command: 'deep-interview',
      args: '--autoresearch improve startup performance',
      raw: '/deep-interview --autoresearch improve startup performance',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText).toContain('## Autoresearch Setup Mode');
    expect(result.replacementText).toContain('autoresearch --mission "<mission>" --eval "<evaluator>"');
    expect(result.replacementText).toContain('Mission seed from invocation: `improve startup performance`');
    expect(result.replacementText).not.toContain('## Skill Pipeline');
  });

  it('renders plugin-safe autoresearch guidance when omc is unavailable in slash mode', async () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/plugin-root';
    process.env.PATH = '';

    mkdirSync(join(tempConfigDir, 'skills', 'deep-interview'), { recursive: true });
    writeFileSync(
      join(tempConfigDir, 'skills', 'deep-interview', 'SKILL.md'),
      `---
name: deep-interview
description: Deep interview
---

Deep interview body`
    );

    const { executeSlashCommand } = await loadExecutor();
    const result = executeSlashCommand({
      command: 'deep-interview',
      args: '--autoresearch improve startup performance',
      raw: '/deep-interview --autoresearch improve startup performance',
    });

    expect(result.success).toBe(true);
    expect(result.replacementText)
      .toContain('node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs autoresearch --mission "<mission>" --eval "<evaluator>"');
  });
});
