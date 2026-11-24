/**
 * Hook Command Portability Tests (Contracts 7-8)
 *
 * Guards against issues #2084 and #2348:
 *   - Hook commands must work across environments (no hardcoded home dirs)
 *   - Hook commands must not contain absolute node binary paths
 *   - Hook commands must reference files that actually exist in templates
 *
 * Tests the exported getHooksSettingsConfig() function which is the public API
 * for standalone hook configuration. Uses vi.resetModules() + dynamic import
 * because HOOKS_SETTINGS_CONFIG_NODE is a module-level constant evaluated at
 * import time based on CLAUDE_CONFIG_DIR.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
// ── Contract 7: getHooksSettingsConfig() generates portable hook commands ─────
describe('Contract 7: hook command portability (#2084, #2348)', () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalPlatform = process.platform;
    afterEach(() => {
        if (originalConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
        else {
            process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        }
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        vi.resetModules();
    });
    it('default config: commands use ${CLAUDE_CONFIG_DIR:-$HOME/.claude} pattern', async () => {
        // POSIX expansion is only emitted on non-Windows platforms (Windows emits
        // concrete paths by design — see the Windows test below). Force a POSIX
        // platform so this contract holds on Windows dev machines too.
        Object.defineProperty(process, 'platform', { value: 'linux' });
        delete process.env.CLAUDE_CONFIG_DIR;
        vi.resetModules();
        const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
        const config = getHooksSettingsConfig();
        const commands = [];
        for (const eventHooks of Object.values(config.hooks)) {
            for (const hookGroup of eventHooks) {
                for (const hook of hookGroup.hooks) {
                    commands.push(hook.command);
                }
            }
        }
        expect(commands.length).toBeGreaterThan(0);
        // On default config, all commands should use the portable env-var pattern
        for (const cmd of commands) {
            expect(cmd).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
        }
    });
    it('no command contains an absolute path to a node binary', async () => {
        delete process.env.CLAUDE_CONFIG_DIR;
        vi.resetModules();
        const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
        const config = getHooksSettingsConfig();
        // Regex: command starts with an absolute path to node binary
        // e.g., /opt/hostedtoolcache/node/20.20.2/x64/bin/node
        // e.g., /usr/local/bin/node
        const absoluteNodePattern = /^["']?\/[^\s"']*node["']?\s/;
        const violations = [];
        for (const [eventType, eventHooks] of Object.entries(config.hooks)) {
            for (const hookGroup of eventHooks) {
                for (const hook of hookGroup.hooks) {
                    if (absoluteNodePattern.test(hook.command)) {
                        violations.push({ event: eventType, command: hook.command });
                    }
                }
            }
        }
        if (violations.length > 0) {
            const details = violations.map(v => `  ${v.event}: ${v.command}`).join('\n');
            expect.fail(`Found absolute node binary paths in hook commands (issue #2348 regression):\n${details}\n\n` +
                `Hook commands must use bare 'node', not resolved absolute paths like /opt/hostedtoolcache/...`);
        }
    });
    it('no command contains a hardcoded home directory path', async () => {
        // Windows emits concrete hook paths by design (see Windows test below), so
        // the POSIX no-hardcoded-home contract is only asserted for POSIX builds.
        Object.defineProperty(process, 'platform', { value: 'linux' });
        delete process.env.CLAUDE_CONFIG_DIR;
        vi.resetModules();
        const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
        const config = getHooksSettingsConfig();
        // Pattern: hardcoded /home/username or /Users/username paths
        const hardcodedHomePattern = /\/(?:home|Users)\/[a-zA-Z0-9_-]+\//;
        const violations = [];
        for (const [eventType, eventHooks] of Object.entries(config.hooks)) {
            for (const hookGroup of eventHooks) {
                for (const hook of hookGroup.hooks) {
                    if (hardcodedHomePattern.test(hook.command)) {
                        violations.push({ event: eventType, command: hook.command });
                    }
                }
            }
        }
        if (violations.length > 0) {
            const details = violations.map(v => `  ${v.event}: ${v.command}`).join('\n');
            expect.fail(`Found hardcoded home directory paths in hook commands:\n${details}\n\n` +
                `Hook commands must use $HOME or \${CLAUDE_CONFIG_DIR:-$HOME/.claude}, not resolved absolute home paths.`);
        }
    });
    it('custom config: commands use the custom absolute path', async () => {
        process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-claude-test-config';
        vi.resetModules();
        const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
        const config = getHooksSettingsConfig();
        const commands = [];
        for (const eventHooks of Object.values(config.hooks)) {
            for (const hookGroup of eventHooks) {
                for (const hook of hookGroup.hooks) {
                    commands.push(hook.command);
                }
            }
        }
        expect(commands.length).toBeGreaterThan(0);
        // With custom config dir, commands should reference the custom path
        for (const cmd of commands) {
            expect(cmd).toContain('/tmp/custom-claude-test-config/hooks/');
        }
    });
    it('Windows default config: emits concrete hook paths without POSIX shell expansion', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        delete process.env.CLAUDE_CONFIG_DIR;
        vi.resetModules();
        const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
        const config = getHooksSettingsConfig();
        const commands = [];
        for (const eventHooks of Object.values(config.hooks)) {
            for (const hookGroup of eventHooks) {
                for (const hook of hookGroup.hooks) {
                    commands.push(hook.command);
                }
            }
        }
        expect(commands.length).toBeGreaterThan(0);
        for (const cmd of commands) {
            expect(cmd).toContain('/.claude/hooks/');
            expect(cmd).not.toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
            expect(cmd).not.toContain('%USERPROFILE%');
        }
    });
});
// ── Contract 8: Hook config commands reference known OMC hook filenames ───────
describe('Contract 8: hook commands reference existing template files', () => {
    it('all hook commands reference files that exist in templates/hooks/', async () => {
        delete process.env.CLAUDE_CONFIG_DIR;
        vi.resetModules();
        const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
        const config = getHooksSettingsConfig();
        const templatesDir = join(REPO_ROOT, 'templates', 'hooks');
        expect(existsSync(templatesDir)).toBe(true);
        const templateFiles = new Set(readdirSync(templatesDir));
        // Extract filenames from hook commands
        const filenamePattern = /([a-z0-9-]+\.mjs)(?:$|["'\s])/;
        const missingFiles = [];
        for (const [eventType, eventHooks] of Object.entries(config.hooks)) {
            for (const hookGroup of eventHooks) {
                for (const hook of hookGroup.hooks) {
                    const match = hook.command.match(filenamePattern);
                    if (match) {
                        const filename = match[1];
                        if (!templateFiles.has(filename)) {
                            missingFiles.push({ event: eventType, filename, command: hook.command });
                        }
                    }
                }
            }
        }
        if (missingFiles.length > 0) {
            const details = missingFiles
                .map(v => `  ${v.event}: ${v.filename} (command: ${v.command})`)
                .join('\n');
            expect.fail(`Hook commands reference files not found in templates/hooks/:\n${details}\n\n` +
                `Ensure all referenced hook scripts exist in templates/hooks/.`);
        }
    });
});
// ── Contract 9: no cmd-style %VAR% in generated hook commands (B2 hook-template-var)
//
// Live-fire evidence (2026-09-29): a hook command using cmd-style
// `%CLAUDE_PROJECT_DIR%` fired 0/3 while the absolute-path form fired 3/3 —
// Claude Code does not variable-expand cmd-style %VAR% in hook command
// strings, so `node "%CLAUDE_PROJECT_DIR%/..."` silently fails to find the
// script. Generated commands must either use concrete paths (Windows) or
// POSIX sh-style expansion ($HOME / ${CLAUDE_CONFIG_DIR:-...}) — never %VAR%.
describe('Contract 9: hook commands contain no cmd-style %VAR% (B2 hook-template-var)', () => {
    const cmdVarPattern = /%[A-Za-z_][A-Za-z0-9_]*%/;
    async function collectCommands(platform) {
        Object.defineProperty(process, 'platform', { value: platform });
        delete process.env.CLAUDE_CONFIG_DIR;
        vi.resetModules();
        const { getHooksSettingsConfig } = await import('../../installer/hooks.js');
        const config = getHooksSettingsConfig();
        const commands = [];
        for (const eventHooks of Object.values(config.hooks)) {
            for (const hookGroup of eventHooks) {
                for (const hook of hookGroup.hooks) {
                    commands.push(hook.command);
                }
            }
        }
        return commands;
    }
    function expectNoCmdStyleVars(commands, platform) {
        expect(commands.length).toBeGreaterThan(0);
        const violations = commands.filter((cmd) => cmdVarPattern.test(cmd));
        if (violations.length > 0) {
            expect.fail(`Found cmd-style %VAR% references in ${platform} hook commands:\n` +
                violations.map(c => `  ${c}`).join('\n') +
                `\n\nClaude Code does not expand cmd-style %VAR% in hook command strings; ` +
                `they silently fail. Use concrete paths or POSIX sh-style expansion instead.`);
        }
    }
    it('Windows default config: no command contains cmd-style %VAR%', async () => {
        expectNoCmdStyleVars(await collectCommands('win32'), 'win32');
    });
    it('POSIX default config: no command contains cmd-style %VAR%', async () => {
        expectNoCmdStyleVars(await collectCommands('linux'), 'linux');
    });
    it('standalone forwarder template (templates/hooks/session-end.mjs) contains no cmd-style %VAR%', () => {
        const templatePath = join(REPO_ROOT, 'templates', 'hooks', 'session-end.mjs');
        expect(existsSync(templatePath)).toBe(true);
        const source = readFileSync(templatePath, 'utf8');
        expect(source).not.toMatch(cmdVarPattern);
    });
});
//# sourceMappingURL=hook-command-portability.test.js.map