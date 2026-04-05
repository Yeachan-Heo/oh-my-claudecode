import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface HooksConfig {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
}

const hooksJsonPath = join(__dirname, '..', '..', 'hooks', 'hooks.json');

function expandHookCommandArgv(command: string, pluginRoot: string): string[] {
  const shellScript =
    `eval "set -- $HOOK_COMMAND"; ` +
    `node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"`;

  return JSON.parse(
    execFileSync('bash', ['-lc', shellScript], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOOK_COMMAND: command,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    }).trim()
  ) as string[];
}

function getHookCommands(): string[] {
  const raw = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as HooksConfig;
  return Object.values(raw.hooks ?? {})
    .flatMap(groups => groups)
    .flatMap(group => group.hooks ?? [])
    .map(hook => hook.command)
    .filter((command): command is string => typeof command === 'string');
}

describe('hooks.json command escaping', () => {
  it('uses shell-expanded CLAUDE_PLUGIN_ROOT segments instead of pre-expanded ${...} placeholders', () => {
    for (const command of getHookCommands()) {
      expect(command).toContain('"$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs');
      expect(command).not.toContain('${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs');
      expect(command).not.toContain('${CLAUDE_PLUGIN_ROOT}/scripts/');
    }
  });

  it('keeps Windows-style plugin roots with spaces intact when bash expands the command', () => {
    const pluginRoot = '/c/Users/First Last/.claude/plugins/cache/omc/oh-my-claudecode/4.7.10';

    for (const command of getHookCommands()) {
      const argv = expandHookCommandArgv(command, pluginRoot);

      expect(argv[0]).toMatch(/(^|[/\\])node(?:\.exe)?$/);
      expect(argv[1]).toBe(`${pluginRoot}/scripts/run.cjs`);
      expect(argv[2]).toContain(`${pluginRoot}/scripts/`);
      expect(argv[1]).toContain('First Last');
      expect(argv[2]).toContain('First Last');
      expect(argv).not.toContain('/c/Users/First');
      expect(argv).not.toContain('Last/.claude/plugins/cache/omc/oh-my-claudecode/4.7.10/scripts/run.cjs');
    }
  });
});
