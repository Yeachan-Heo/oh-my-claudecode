import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
const hooksJsonPath = join(__dirname, '..', '..', 'hooks', 'hooks.json');
function getHookCommands() {
    const raw = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    return Object.values(raw.hooks ?? {})
        .flatMap(groups => groups)
        .flatMap(group => group.hooks ?? [])
        .map(hook => hook.command)
        .filter((command) => typeof command === 'string');
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
            const argv = JSON.parse(execFileSync('bash', ['-lc', command.replace(/^node\b/, `node -e "console.log(JSON.stringify(process.argv.slice(1)))"`)], {
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    CLAUDE_PLUGIN_ROOT: pluginRoot,
                },
            }).trim());
            expect(argv[0]).toBe(`${pluginRoot}/scripts/run.cjs`);
            expect(argv[1]).toContain(`${pluginRoot}/scripts/`);
            expect(argv[0]).toContain('First Last');
            expect(argv[1]).toContain('First Last');
            expect(argv).not.toContain('/c/Users/First');
            expect(argv).not.toContain('Last/.claude/plugins/cache/omc/oh-my-claudecode/4.7.10/scripts/run.cjs');
        }
    });
});
//# sourceMappingURL=hooks-command-escaping.test.js.map