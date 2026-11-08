import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  appendFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    appendFile: fsMocks.appendFile,
    mkdir: fsMocks.mkdir,
    readFile: fsMocks.readFile,
  };
});

describe('emitMonitorDerivedEvents swallowed error logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fsMocks.appendFile.mockReset();
    fsMocks.mkdir.mockReset();
    fsMocks.readFile.mockReset();
  });

  it('logs appendTeamEvent failures without throwing', async () => {
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.appendFile.mockRejectedValue(new Error('disk full'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emitMonitorDerivedEvents } = await import('../events.js');

    await expect(emitMonitorDerivedEvents(
      'demo-team',
      [{ id: 'task-1', status: 'completed' }],
      [],
      { taskStatusById: { 'task-1': 'in_progress' } },
      '/tmp/demo-team',
    )).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      '[omc] team.events.emitMonitorDerivedEvents appendTeamEvent failed: disk full',
    );
  });
});
