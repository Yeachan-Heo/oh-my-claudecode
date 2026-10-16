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
    expect(integerOption(0)(' 0 ')).toBe(0);
    expect(integerOption(1, 1000)('1000')).toBe(1000);
  });

  it.each(['', 'abc', '5x', '1.5', '-3', '0x10', '1e3', String(Number.MAX_SAFE_INTEGER) + '0'])(
    'rejects %j',
    (raw) => {
      expect(() => integerOption(0)(raw)).toThrow(InvalidArgumentError);
    },
  );

  it('rejects values outside the range', () => {
    expect(() => integerOption(1)('0')).toThrow('at least 1');
    expect(() => integerOption(1, 86400)('86401')).toThrow('between 1 and 86400');
  });
});

describe('omc numeric options', () => {
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
    [['session', 'search', 'foo', '--limit', 'abc'], '--limit'],
    [['session', 'search', 'foo', '--context', '-1'], '--context'],
    [['session', 'friction', 'report', '--limit', '0'], '--limit'],
    [['wait', 'daemon', 'start', '--interval', 'abc'], '--interval'],
    [['wait', 'daemon', 'start', '--interval', '-5'], '--interval'],
    [['wait', 'detect', '--lines', '10x'], '--lines'],
  ])('rejects %j', async (args, option) => {
    expect(await parse(args)).toContain(option);
  });
});
