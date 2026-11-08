/**
 * Tests for --plugin-dir support in `omc doctor` and `omc doctor conflicts`.
 *
 * Section 1 (applyPluginDirOption unit tests): tests the helper directly.
 * Section 2 (Commander integration tests): constructs the actual program via
 *   buildProgram() and calls parseAsync() to verify the flag is wired end-to-end.
 *
 * OMC_CLI_SKIP_PARSE prevents index.ts from calling program.parse() at import
 * time (which would trigger launchCommand → process.exit inside the test
 * worker that inherits CLAUDECODE from the parent Claude Code session).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { OMC_PLUGIN_ROOT_ENV } from '../../lib/env-vars.js';
// Prevent auto-parse when index.ts is imported
process.env.OMC_CLI_SKIP_PARSE = '1';
describe('applyPluginDirOption', () => {
    let savedEnv;
    let warnSpy;
    beforeEach(() => {
        savedEnv = process.env[OMC_PLUGIN_ROOT_ENV];
        delete process.env[OMC_PLUGIN_ROOT_ENV];
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        if (savedEnv === undefined) {
            delete process.env[OMC_PLUGIN_ROOT_ENV];
        }
        else {
            process.env[OMC_PLUGIN_ROOT_ENV] = savedEnv;
        }
        warnSpy.mockRestore();
    });
    it('sets OMC_PLUGIN_ROOT for an absolute path', async () => {
        const { applyPluginDirOption } = await import('../index.js');
        applyPluginDirOption('/tmp/foo');
        expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBe(resolve('/tmp/foo'));
    });
    it('resolves a relative path to absolute', async () => {
        const { applyPluginDirOption } = await import('../index.js');
        applyPluginDirOption('./rel/path');
        expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBe(resolve('./rel/path'));
    });
    it('is a no-op when rawPath is undefined', async () => {
        const { applyPluginDirOption } = await import('../index.js');
        applyPluginDirOption(undefined);
        expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBeUndefined();
    });
    it('wins over a pre-set OMC_PLUGIN_ROOT env var', async () => {
        process.env[OMC_PLUGIN_ROOT_ENV] = '/tmp/existing';
        const { applyPluginDirOption } = await import('../index.js');
        applyPluginDirOption('/tmp/override');
        expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBe(resolve('/tmp/override'));
    });
    it('logs a warning when overriding a pre-set env var (flag wins, warning emitted)', async () => {
        process.env[OMC_PLUGIN_ROOT_ENV] = '/tmp/existing';
        const { applyPluginDirOption } = await import('../index.js');
        applyPluginDirOption('/tmp/override');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/tmp/override'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/tmp/existing'));
    });
    it('does NOT warn when no pre-existing env var is set', async () => {
        const { applyPluginDirOption } = await import('../index.js');
        applyPluginDirOption('/tmp/foo');
        expect(warnSpy).not.toHaveBeenCalled();
    });
    it('relative path (subcommand form) is resolved to absolute', async () => {
        const { applyPluginDirOption } = await import('../index.js');
        // Simulates: omc doctor conflicts --plugin-dir ./mydir
        applyPluginDirOption('./mydir');
        expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBe(resolve('./mydir'));
    });
});
/**
 * Commander integration tests — verifies the --plugin-dir flag is actually
 * wired into the program tree, not just that the helper function works in
 * isolation.  If the flag were silently removed from `doctorCmd`, these tests
 * would catch it.
 *
 * Strategy: inspect the Commander option definitions on the doctor command and
 * its `conflicts` subcommand directly from the program singleton.  This avoids
 * the complexity of executing actions (which call process.exit or spawn real
 * IO) while still verifying the flag is registered in the Commander tree.
 *
 * For the `conflicts` subcommand action path we also verify that parsing
 * `doctor conflicts --plugin-dir /tmp/foo` actually delivers the parsed option
 * value to the subcommand by intercepting the action before it reaches
 * doctorConflictsCommand.
 */
describe('Commander integration: doctor --plugin-dir wiring', () => {
    it('doctor command has --plugin-dir option registered', async () => {
        const { buildProgram } = await import('../index.js');
        const prog = buildProgram();
        const doctorCmd = prog.commands.find(c => c.name() === 'doctor');
        expect(doctorCmd).toBeDefined();
        const opt = doctorCmd.options.find(o => o.long === '--plugin-dir');
        expect(opt).toBeDefined();
        expect(opt.required).toBe(true); // <path> is a required option argument
    });
    it('doctor conflicts subcommand has --plugin-dir option registered', async () => {
        const { buildProgram } = await import('../index.js');
        const prog = buildProgram();
        const doctorCmd = prog.commands.find(c => c.name() === 'doctor');
        expect(doctorCmd).toBeDefined();
        const conflictsCmd = doctorCmd.commands.find(c => c.name() === 'conflicts');
        expect(conflictsCmd).toBeDefined();
        const opt = conflictsCmd.options.find(o => o.long === '--plugin-dir');
        expect(opt).toBeDefined();
    });
    it('parseAsync doctor conflicts --plugin-dir /tmp/foo sets OMC_PLUGIN_ROOT', async () => {
        // Mock the doctorConflictsCommand so the action completes without real IO
        // and without calling process.exit.
        vi.mock('../commands/doctor-conflicts.js', () => ({
            doctorConflictsCommand: vi.fn().mockResolvedValue(0),
        }));
        const savedEnv = process.env[OMC_PLUGIN_ROOT_ENV];
        delete process.env[OMC_PLUGIN_ROOT_ENV];
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { }));
        try {
            const { buildProgram } = await import('../index.js');
            const prog = buildProgram();
            await prog.parseAsync(['node', 'omc', 'doctor', 'conflicts', '--plugin-dir', '/tmp/foo']);
            expect(process.env[OMC_PLUGIN_ROOT_ENV]).toBe(resolve('/tmp/foo'));
        }
        finally {
            exitSpy.mockRestore();
            if (savedEnv === undefined) {
                delete process.env[OMC_PLUGIN_ROOT_ENV];
            }
            else {
                process.env[OMC_PLUGIN_ROOT_ENV] = savedEnv;
            }
        }
    });
});
//# sourceMappingURL=doctor-plugin-dir.test.js.map