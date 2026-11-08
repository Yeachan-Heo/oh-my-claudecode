import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doctorTeamRoutingCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../commands/doctor-team-routing.js', () => ({
  doctorTeamRoutingCommand: doctorTeamRoutingCommandMock,
}));

const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
process.env.OMC_CLI_SKIP_PARSE = '1';

async function parseDoctor(args: string[]): Promise<void> {
  vi.resetModules();
  const { buildProgram } = await import('../index.js');
  await buildProgram().parseAsync(['node', 'omc', ...args]);
}

describe('doctor team-routing Commander integration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    doctorTeamRoutingCommandMock.mockReset();
    doctorTeamRoutingCommandMock.mockResolvedValue(0);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  afterAll(() => {
    if (originalSkipParse === undefined) delete process.env.OMC_CLI_SKIP_PARSE;
    else process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
  });

  it('dispatches doctor team-routing --json without probing real providers', async () => {
    await parseDoctor(['doctor', 'team-routing', '--json']);

    expect(doctorTeamRoutingCommandMock).toHaveBeenCalledWith({ json: true });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('dispatches doctor --team-routing --json and propagates the command exit code', async () => {
    doctorTeamRoutingCommandMock.mockResolvedValueOnce(1);

    await parseDoctor(['doctor', '--team-routing', '--json']);

    expect(doctorTeamRoutingCommandMock).toHaveBeenCalledWith({ json: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
