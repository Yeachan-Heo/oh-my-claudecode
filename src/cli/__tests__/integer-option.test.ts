import { afterAll, describe, expect, it } from 'vitest';
import { Command, InvalidArgumentError } from 'commander';

import { integerOption } from '../utils/integer-option.js';

const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
process.env.OMC_CLI_SKIP_PARSE = '1';

afterAll(() => {
  if (originalSkipParse === undefined) delete process.env.OMC_CLI_SKIP_PARSE;
  else process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
});

describe('integerOption', () => {
  it('accepts whole numbers inside the range', () => {
    expect(integerOption(1)('10')).toBe(10);
    expect(integerOption(1)(' +10 ')).toBe(10);
    expect(integerOption(0)(' 0 ')).toBe(0);
    expect(integerOption(1)('86401')).toBe(86401);
    expect(integerOption(1)('1001')).toBe(1001);
    expect(integerOption(1, 1000)('1000')).toBe(1000);
  });

  it.each(['', 'abc', '5x', '1.5', '-3', '0x10', '1e3', String(Number.MAX_SAFE_INTEGER) + '0'])(
    'rejects %j',
    (raw) => {
      expect(() => integerOption(0)(raw)).toThrow(InvalidArgumentError);
    },
  );

  it('rejects values outside an explicitly configured range', () => {
    expect(() => integerOption(1)('0')).toThrow('at least 1');
    expect(() => integerOption(1, 86400)('86401')).toThrow('between 1 and 86400');
  });
});

describe('omc numeric options', () => {
  it('preserves defaults, valid ranges, and duration-string options', async () => {
    const { buildProgram } = await import('../index.js');
    const program = buildProgram();
    const command = (parent: Command, name: string): Command => {
      const match = parent.commands.find((candidate) => candidate.name() === name);
      if (!match) throw new Error(`Missing ${name} command`);
      return match;
    };
    const option = (target: Command, name: string) => {
      const match = target.options.find((candidate) => candidate.long === name);
      if (!match) throw new Error(`Missing ${name} option`);
      return match;
    };

    const wait = command(program, 'wait');
    const interval = option(command(wait, 'daemon'), '--interval');
    const lines = option(command(wait, 'detect'), '--lines');
    expect(interval.defaultValue).toBe(60);
    expect(interval.parseArg?.('86401', undefined)).toBe(86401);
    expect(lines.defaultValue).toBe(15);
    expect(lines.parseArg?.('1001', undefined)).toBe(1001);

    const session = command(program, 'session');
    const search = command(session, 'search');
    const limit = option(search, '--limit');
    const context = option(search, '--context');
    expect(limit.defaultValue).toBe(10);
    expect(limit.parseArg?.('1', undefined)).toBe(1);
    expect(context.defaultValue).toBe(120);
    expect(context.parseArg?.('0', undefined)).toBe(0);

    const friction = command(command(session, 'friction'), 'report');
    const frictionLimit = option(friction, '--limit');
    expect(frictionLimit.defaultValue).toBe(10);
    expect(frictionLimit.parseArg?.('1', undefined)).toBe(1);

    expect(option(search, '--since').parseArg).toBeUndefined();
  });

  async function parse(args: string[]): Promise<string> {
    const { buildProgram } = await import('../index.js');
    const program = buildProgram();
    let stderr = '';
    const harden = (command: Command): void => {
      command.exitOverride().configureOutput({ writeErr: (text) => { stderr += text; }, writeOut: () => {} });
      command.commands.forEach(harden);
    };
    harden(program);
    await expect(program.parseAsync(['node', 'omc', ...args])).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    return stderr;
  }

  it.each([
    { args: ['session', 'search', 'foo', '--limit', 'abc'], option: '--limit', message: 'at least 1' },
    { args: ['session', 'search', 'foo', '--context', '-1'], option: '--context', message: 'at least 0' },
    { args: ['session', 'friction', 'report', '--limit', '0'], option: '--limit', message: 'at least 1' },
    { args: ['wait', 'daemon', 'start', '--interval', 'abc'], option: '--interval', message: 'at least 1' },
    { args: ['wait', 'daemon', 'start', '--interval', '-5'], option: '--interval', message: 'at least 1' },
    { args: ['wait', 'detect', '--lines', '10x'], option: '--lines', message: 'at least 1' },
  ])('rejects $option with an explanatory message', async ({ args, option, message }) => {
    const stderr = await parse(args);
    expect(stderr).toContain(option);
    expect(stderr).toContain(message);
  });
});
