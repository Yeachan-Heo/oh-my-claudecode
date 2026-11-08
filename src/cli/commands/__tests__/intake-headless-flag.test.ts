import { describe, expect, it } from 'vitest';
import { intakeCommand } from '../intake.js';

/**
 * `intake schedule` writes `omc intake run --headless ...` into cron / Task
 * Scheduler. The `run` subcommand must therefore accept `--headless`, or every
 * scheduled sweep dies with `unknown option` before it starts.
 */
describe('intake run accepts the flag its scheduled entry passes', () => {
  it('registers --headless on `intake run`', () => {
    const run = intakeCommand().commands.find((sub) => sub.name() === 'run');
    expect(run).toBeDefined();
    const flags = run!.options.map((option) => option.long);
    expect(flags).toContain('--headless');
    expect(flags).toContain('--allow-docket-only');
    expect(flags).toContain('--cwd');
  });

  it('parses the scheduled argv without an unknown-option error', () => {
    const cmd = intakeCommand();
    const run = cmd.commands.find((sub) => sub.name() === 'run')!;
    // Replace the action so parsing does not start a real sweep.
    let parsed: Record<string, unknown> | undefined;
    run.action((options: Record<string, unknown>) => {
      parsed = options;
    });
    cmd.exitOverride();
    expect(() =>
      cmd.parse(['run', '--headless', '--allow-docket-only', '--cwd', 'C:/repo'], { from: 'user' }),
    ).not.toThrow();
    expect(parsed).toMatchObject({ headless: true, allowDocketOnly: true, cwd: 'C:/repo' });
  });
});
