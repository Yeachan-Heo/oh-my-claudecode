import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const hooksJsonPath = join(__dirname, '..', '..', 'hooks', 'hooks.json');
function expandHookCommandArgv(command, pluginRoot) {
    const shellScript = `eval "set -- $HOOK_COMMAND"; ` +
        `node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"`;
    return JSON.parse(execFileSync('bash', ['-lc', shellScript], {
        encoding: 'utf-8',
        env: {
            ...process.env,
            HOOK_COMMAND: command,
            CLAUDE_PLUGIN_ROOT: pluginRoot,
        },
    }).trim());
}
function getHookCommands() {
    const raw = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    return Object.entries(raw.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap(group => (group.hooks ?? [])
        .map(hook => hook.command)
        .filter((command) => typeof command === 'string')
        .map(command => ({ event, command }))));
}
describe('hooks.json command escaping', () => {
    it('uses portable hook commands without absolute /bin/sh or pre-expanded ${...} placeholders', () => {
        for (const { command } of getHookCommands()) {
            expect(command).toMatch(/^node "\$CLAUDE_PLUGIN_ROOT"\/scripts\/run\.cjs "\$CLAUDE_PLUGIN_ROOT"\/scripts\/[^\s]+/);
            expect(command).not.toContain('find-node.sh');
            expect(command).not.toMatch(/^sh /);
            expect(command).not.toContain('/bin/sh');
            expect(command).not.toContain('${CLAUDE_PLUGIN_ROOT}/scripts/run.cjs');
            expect(command).not.toContain('${CLAUDE_PLUGIN_ROOT}/scripts/');
        }
    });
    it('keeps Windows-style plugin roots with spaces intact when bash expands the command', () => {
        const pluginRoot = '/c/Users/First Last/.claude/plugins/cache/omc/oh-my-claudecode/4.7.10';
        for (const { command } of getHookCommands()) {
            const argv = expandHookCommandArgv(command, pluginRoot);
            expect(argv[0]).toBe('node');
            expect(argv[1]).toBe(`${pluginRoot}/scripts/run.cjs`);
            expect(argv[2]).toContain(`${pluginRoot}/scripts/`);
            expect(argv[1]).toContain('First Last');
            expect(argv[2]).toContain('First Last');
            expect(argv).not.toContain('/c/Users/First');
            expect(argv).not.toContain('Last/.claude/plugins/cache/omc/oh-my-claudecode/4.7.10/scripts/run.cjs');
        }
    });
    it('find-node bootstrap can execute when node is absent from PATH', () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'omc-hook-node-path-'));
        const configDir = join(homeDir, '.claude');
        try {
            execFileSync('/bin/mkdir', ['-p', configDir]);
            writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ nodeBinary: process.execPath }), 'utf-8');
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
        }
        finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=hooks-command-escaping.test.js.map