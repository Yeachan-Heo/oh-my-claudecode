import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface HooksConfig {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
}

interface HookCommandEntry {
  event: string;
  command: string;
  args?: string[];
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

function getHookCommands(): HookCommandEntry[] {
  const raw = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; args?: string[] }> }>>;
  };
  return Object.entries(raw.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap(group =>
      (group.hooks ?? [])
        .filter((hook): hook is { command: string; args?: string[] } => typeof hook.command === 'string')
        .map(hook => ({ event, command: hook.command, args: hook.args })),
    ),
  );
}

describe('hooks.json command escaping', () => {
  it('uses exec form so a shell cannot split the plugin root', () => {
    for (const hook of getHookCommands()) {
      expect(hook.command).toBe('node');
      expect(hook.args?.[0]).toBe('${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs');
      expect(hook.args?.[1]).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[A-Za-z0-9._-]+\.mjs$/);
      expect(JSON.stringify(hook)).not.toContain('find-node.sh');
      expect(hook.command).not.toMatch(/^sh /);
      expect(JSON.stringify(hook)).not.toContain('/bin/sh');
    }
  });

  it('keeps a plugin root that contains spaces inside one argument', () => {
    const pluginRoot = '/c/Users/First Last/.claude/plugins/cache/omc/oh-my-claudecode/4.7.10';

    for (const hook of getHookCommands()) {
      const argv = [
        hook.command,
        ...(hook.args ?? []).map(arg => arg.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot)),
      ];

      expect(argv[0]).toBe('node');
      expect(argv[1]).toBe(`${pluginRoot}/scripts/run.cjs`);
      expect(argv[2]).toContain(`${pluginRoot}/scripts/`);
      expect(argv[1]).toContain('First Last');
      expect(argv[2]).toContain('First Last');
      expect(argv.some(arg => arg === '/c/Users/First')).toBe(false);
      expect(argv.some(arg => arg.endsWith('Last/.claude/plugins/cache/omc/oh-my-claudecode/4.7.10/scripts/run.cjs') && !arg.includes('First Last'))).toBe(false);
    }
  });

  it('find-node bootstrap can execute when node is absent from PATH', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'omc-hook-node-path-'));
    const configDir = join(homeDir, '.claude');

    try {
      execFileSync('/bin/mkdir', ['-p', configDir]);
      writeFileSync(
        join(configDir, '.omc-config.json'),
        JSON.stringify({ nodeBinary: process.execPath }),
        'utf-8',
      );

      const stdout = execFileSync('/bin/sh', [
        join(process.cwd(), 'scripts', 'find-node.sh'),
        '-e',
        "process.stdout.write('ok')",
      ], {
        encoding: 'utf-8',
        env: {
          HOME: homeDir,
          CLAUDE_CONFIG_DIR: configDir,
          PATH: '/usr/bin:/bin',
        },
      });

      expect(stdout).toBe('ok');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
