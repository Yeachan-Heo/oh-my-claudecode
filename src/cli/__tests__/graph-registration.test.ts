import { describe, expect, it, vi } from 'vitest';

process.env.OMC_CLI_SKIP_PARSE = '1';

const graphCommandMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../commands/graph.js', () => ({ graphCommand: graphCommandMock }));

describe('Commander Graph registration', () => {
  it('registers one command and forwards raw arguments to its strict boundary', async () => {
    const { buildProgram } = await import('../index.js');
    const program = buildProgram();
    const commands = program.commands.filter((command) => command.name() === 'graph');

    expect(commands).toHaveLength(1);
    await program.parseAsync([
      'node',
      'omc',
      'graph',
      'status',
      '--run-id',
      'run-1',
      '--session-id',
      'session-1',
      '--json',
    ]);
    expect(graphCommandMock).toHaveBeenCalledWith([
      'status',
      '--run-id',
      'run-1',
      '--session-id',
      'session-1',
      '--json',
    ]);
  });
});
