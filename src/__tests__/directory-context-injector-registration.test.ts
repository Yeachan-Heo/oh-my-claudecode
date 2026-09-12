/**
 * Registration contract for the PostToolUse directory-context injector (issue #4006).
 *
 * The injector implementation shipped for two releases while being registered
 * nowhere, so no install ever ran it: `deepinit` wrote nested AGENTS.md files
 * that nothing read. These tests pin the wiring, not the walking logic (which
 * directory-context-injector.test.ts already covers).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT_NAME = 'post-tool-directory-context-injector.mjs';
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', SCRIPT_NAME);
const DIST_HOOK = join(REPO_ROOT, 'dist', 'hooks', 'directory-readme-injector', 'index.js');

interface HookCommand { type: string; command: string; timeout?: number }
interface HookGroup { matcher: string; hooks: HookCommand[] }

function postToolUseCommands(): string[] {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8')) as {
    hooks: Record<string, HookGroup[]>;
  };
  return (config.hooks.PostToolUse ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));
}

function runInjector(payload: unknown, env: Record<string, string> = {}): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...env },
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe('PostToolUse directory-context injector registration (issue #4006)', () => {
  it('ships the wrapper script', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('registers the wrapper on PostToolUse so nested AGENTS.md is actually delivered', () => {
    const commands = postToolUseCommands();
    expect(commands.some((command) => command.includes(SCRIPT_NAME))).toBe(true);
  });

  it('loads the hook from the built dist path the build emits', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(source).toContain("'dist', 'hooks', 'directory-readme-injector', 'index.js'");
    expect(source).toContain('createDirectoryReadmeInjectorHook');
  });

  it('continues without context when stdin is empty', () => {
    expect(runInjector('')).toEqual({ continue: true });
  });

  it('honors DISABLE_OMC and the post-tool-use skip token', () => {
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: join(REPO_ROOT, 'package.json') },
      session_id: 'kill-switch',
      cwd: REPO_ROOT,
    };
    expect(runInjector(payload, { DISABLE_OMC: '1' })).toEqual({ continue: true });
    expect(runInjector(payload, { OMC_SKIP_HOOKS: 'post-tool-use' })).toEqual({ continue: true });
  });

  it.skipIf(!existsSync(DIST_HOOK))('injects a nested AGENTS.md for a tracked tool call', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'omc-injector-e2e-'));
    try {
      mkdirSync(join(projectRoot, 'src', 'nested'), { recursive: true });
      writeFileSync(join(projectRoot, 'src', 'nested', 'AGENTS.md'), '# nested\n\nNESTED-AGENTS-TOKEN\n');
      writeFileSync(join(projectRoot, 'src', 'nested', 'code.ts'), 'export {};\n');

      const result = runInjector({
        tool_name: 'Read',
        tool_input: { file_path: join(projectRoot, 'src', 'nested', 'code.ts') },
        session_id: `e2e-${Date.now()}`,
        cwd: projectRoot,
      });

      expect(result.continue).toBe(true);
      const output = result.hookSpecificOutput as { hookEventName: string; additionalContext: string };
      expect(output.hookEventName).toBe('PostToolUse');
      expect(output.additionalContext).toContain('NESTED-AGENTS-TOKEN');
      expect(output.additionalContext).toContain('[Project AGENTS:');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
