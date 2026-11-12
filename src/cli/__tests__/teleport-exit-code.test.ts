import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// teleportCommand returns { success: false, error } when it fails and prints the
// error only in text mode. `omc teleport <ref>` then sets exit code 1, and with
// --json it prints the error on stdout, like `teleport remove`. It sets
// process.exitCode instead of calling process.exit(), so a long error is written
// in full when stdout is a pipe.
const mocks = vi.hoisted(() => ({
  teleportCommand: vi.fn(),
}));

vi.mock('../commands/teleport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/teleport.js')>()),
  teleportCommand: mocks.teleportCommand,
}));

const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
process.env.OMC_CLI_SKIP_PARSE = '1';

async function parse(args: string[]): Promise<void> {
  vi.resetModules();
  const { buildProgram } = await import('../index.js');
  await buildProgram().parseAsync(['node', 'omc', ...args]);
}

describe('omc teleport <ref> exit code', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.teleportCommand.mockReset();
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  afterAll(() => {
    if (originalSkipParse === undefined) delete process.env.OMC_CLI_SKIP_PARSE;
    else process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
  });

  it('prints the error as JSON and exits 1 when teleport fails with --json', async () => {
    const error = 'Not in a git repository. Run this command from within a git repo.';
    mocks.teleportCommand.mockResolvedValue({ success: false, error });

    await parse(['teleport', 'my-feature', '--json']);

    expect(mocks.teleportCommand).toHaveBeenCalledWith('my-feature', expect.objectContaining({ json: true }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ success: false, error });
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 without writing to stdout when teleport fails in text mode', async () => {
    mocks.teleportCommand.mockResolvedValue({ success: false, error: 'Worktree already exists at /w/feat/repo-x' });

    await parse(['teleport', 'my-feature']);

    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('keeps exit 0 when teleport succeeds', async () => {
    mocks.teleportCommand.mockResolvedValue({ success: true, worktreePath: '/w/feat/repo-x', branch: 'feat/x' });

    await parse(['teleport', 'my-feature', '--json']);

    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
