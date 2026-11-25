import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `wait`, `teleport` and `doctor` define --json themselves, so Commander hands a
// --json given after their subcommands to the parent. These subcommands read it
// with optsWithGlobals(), like `doctor team-routing`.
const mocks = vi.hoisted(() => ({
    waitStatusCommand: vi.fn(),
    waitDetectCommand: vi.fn(),
    teleportListCommand: vi.fn(),
    teleportRemoveCommand: vi.fn(),
    doctorConflictsCommand: vi.fn(),
}));
vi.mock('../commands/wait.js', async (importOriginal) => ({
    ...(await importOriginal()),
    waitStatusCommand: mocks.waitStatusCommand,
    waitDetectCommand: mocks.waitDetectCommand,
}));
vi.mock('../commands/teleport.js', async (importOriginal) => ({
    ...(await importOriginal()),
    teleportListCommand: mocks.teleportListCommand,
    teleportRemoveCommand: mocks.teleportRemoveCommand,
}));
vi.mock('../commands/doctor-conflicts.js', () => ({
    doctorConflictsCommand: mocks.doctorConflictsCommand,
}));
const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
process.env.OMC_CLI_SKIP_PARSE = '1';
async function parse(args) {
    vi.resetModules();
    const { buildProgram } = await import('../index.js');
    await buildProgram().parseAsync(['node', 'omc', ...args]);
}
describe('--json on subcommands whose parent also defines --json', () => {
    let exitSpy;
    beforeEach(() => {
        for (const mock of Object.values(mocks)) {
            mock.mockReset();
            mock.mockResolvedValue(0);
        }
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { }));
    });
    afterEach(() => {
        exitSpy.mockRestore();
    });
    afterAll(() => {
        if (originalSkipParse === undefined)
            delete process.env.OMC_CLI_SKIP_PARSE;
        else
            process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
    });
    it('passes --json to wait status', async () => {
        await parse(['wait', 'status', '--json']);
        expect(mocks.waitStatusCommand).toHaveBeenCalledWith({ json: true });
    });
    it('passes --json to wait detect and keeps --lines', async () => {
        await parse(['wait', 'detect', '--json', '--lines', '30']);
        expect(mocks.waitDetectCommand).toHaveBeenCalledWith({ json: true, lines: 30 });
    });
    it('passes --json to teleport list', async () => {
        await parse(['teleport', 'list', '--json']);
        expect(mocks.teleportListCommand).toHaveBeenCalledWith({ json: true });
    });
    it('passes --json to teleport remove', async () => {
        await parse(['teleport', 'remove', 'feat/x', '--json']);
        expect(mocks.teleportRemoveCommand).toHaveBeenCalledWith('feat/x', { json: true });
    });
    it('passes --json to teleport rm and keeps --force', async () => {
        await parse(['teleport', 'rm', 'feat/x', '--force', '--json']);
        expect(mocks.teleportRemoveCommand).toHaveBeenCalledWith('feat/x', { force: true, json: true });
    });
    it('passes --json to doctor conflicts', async () => {
        await parse(['doctor', 'conflicts', '--json']);
        expect(mocks.doctorConflictsCommand).toHaveBeenCalledWith({ json: true });
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
    it('accepts --json before the subcommand name', async () => {
        await parse(['wait', '--json', 'status']);
        expect(mocks.waitStatusCommand).toHaveBeenCalledWith({ json: true });
    });
    it('leaves text output alone without --json', async () => {
        await parse(['teleport', 'list']);
        await parse(['doctor', 'conflicts']);
        expect(mocks.teleportListCommand).toHaveBeenCalledWith({});
        expect(mocks.doctorConflictsCommand).toHaveBeenCalledWith({});
    });
});
//# sourceMappingURL=subcommand-json-flag.test.js.map