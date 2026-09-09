/**
 * CLI adapter tests for `omc graph run` (worker-8).
 *
 * Drives the commander Command object directly — never spawns the full bin.
 * The runner module is mocked so this suite isolates the CLI's own contract:
 * descriptor load/seal, fresh-vs-resume identity check, and exit-code wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealGraphDescriptor } from '../../descriptor.js';
import type { SealedGraphDescriptor } from '../../types.js';
import { EXIT_CODES } from '../../runtime/types.js';
import type { RunResult, RunOptions } from '../../runtime/types.js';
import { graphCommand } from '../../../cli/graph.js';

const mocks = vi.hoisted(() => ({
  runGraph: vi.fn(),
}));

vi.mock('../../runtime/runner.js', () => ({ runGraph: mocks.runGraph }));

function commandNode(id: string) {
  return {
    id,
    kind: 'command' as const,
    title: `Node ${id}`,
    timeout_ms: 60_000,
    max_attempts: 3,
    effect_policy: { policy: 'side_effect_free' as const },
    command: `echo ${id}`,
  };
}

function descriptorInput(runId: string, goal: string) {
  return {
    descriptor_version: 1,
    run_id: runId,
    revision_id: 'rev-cli',
    goal,
    nodes: [commandNode('start'), commandNode('term')],
    edges: [{ id: 'e-start-term', kind: 'fixed' as const, from: 'start', to: 'term' }],
    entry_node_ids: ['start'],
    concurrency_limit: 1,
    terminal_verification_node_id: 'term',
  };
}

describe('graphCommand run subcommand', () => {
  const createConsoleErrorSpy = () =>
    vi.spyOn(console, 'error').mockImplementation(() => {});
  let workDir: string;
  let previousExitCode: typeof process.exitCode;
  let errorSpy: ReturnType<typeof createConsoleErrorSpy>;

  beforeEach(() => {
    workDir = join(mkdtempSync(join(tmpdir(), 'omc-cli-graph-')), 'repo');
    mkdirSync(workDir, { recursive: true });
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    errorSpy = createConsoleErrorSpy();
    mocks.runGraph.mockReset();
    mocks.runGraph.mockImplementation(async (sealed: SealedGraphDescriptor): Promise<RunResult> => ({
      terminal: 'succeeded',
      run_id: sealed.run_id,
      descriptor_hash: sealed.descriptor_hash,
      epoch: 1,
      exit_code: EXIT_CODES.OK,
    }));
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = previousExitCode;
    rmSync(workDir, { recursive: true, force: true });
  });

  async function parseCli(argv: readonly string[]): Promise<void> {
    await graphCommand().parseAsync([...argv], { from: 'user' });
  }

  it('runs a fresh descriptor end to end with exit code 0', async () => {
    // Arrange
    const runsRoot = join(workDir, '.omc', 'graph-runs');
    const fixturePath = join(workDir, 'descriptor.json');
    writeFileSync(fixturePath, JSON.stringify(descriptorInput('run-cli-happy', 'CLI happy path')));

    // Act
    await parseCli(['run', fixturePath, '--runs-root', runsRoot]);

    // Assert
    expect(process.exitCode).toBe(EXIT_CODES.OK);
    expect(mocks.runGraph).toHaveBeenCalledTimes(1);
    const [sealedArg, optionsArg] = mocks.runGraph.mock.calls[0] as [
      SealedGraphDescriptor,
      RunOptions,
    ];
    expect(sealedArg.run_id).toBe('run-cli-happy');
    expect(sealedArg.descriptor_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(optionsArg.runsRoot).toBe(runsRoot);
    expect(optionsArg.executors).toHaveLength(2);
    expect(typeof optionsArg.prompter.prompt).toBe('function');
    expect(typeof optionsArg.reporter?.onEvent).toBe('function');
  });

  it('accepts resume when stored descriptor matches the requested revision', async () => {
    // Arrange
    const input = descriptorInput('run-cli-resume', 'resume identity');
    const sealed = sealGraphDescriptor(input);
    const runsRoot = join(workDir, '.omc', 'graph-runs');
    const storedPath = join(runsRoot, input.run_id, 'descriptor.json');
    mkdirSync(join(runsRoot, input.run_id), { recursive: true });
    writeFileSync(storedPath, JSON.stringify(sealed));
    const fixturePath = join(workDir, 'descriptor.json');
    writeFileSync(fixturePath, JSON.stringify(input));

    // Act
    await parseCli(['run', fixturePath, '--runs-root', runsRoot]);

    // Assert
    expect(process.exitCode).toBe(EXIT_CODES.OK);
    const [sealedArg] = mocks.runGraph.mock.calls[0] as [SealedGraphDescriptor];
    expect(sealedArg.descriptor_hash).toBe(sealed.descriptor_hash);
  });

  it('fails with exit code 21 when stored revision differs from the user file', async () => {
    // Arrange
    const input = descriptorInput('run-cli-mismatch', 'first revision');
    const tampered = { ...input, goal: 'second revision' };
    const sealedStored = sealGraphDescriptor(input);
    const runsRoot = join(workDir, '.omc', 'graph-runs');
    const storedPath = join(runsRoot, input.run_id, 'descriptor.json');
    mkdirSync(join(runsRoot, input.run_id), { recursive: true });
    writeFileSync(storedPath, JSON.stringify(sealedStored));
    const fixturePath = join(workDir, 'descriptor.json');
    writeFileSync(fixturePath, JSON.stringify(tampered));

    // Act
    await parseCli(['run', fixturePath, '--runs-root', runsRoot]);

    // Assert
    expect(process.exitCode).toBe(EXIT_CODES.DESCRIPTOR_MISMATCH);
    expect(errorSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toMatch(
      /different revision/,
    );
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it('maps unmapped runtime crashes to exit code 70 with a [crash] message', async () => {
    // Arrange
    const runsRoot = join(workDir, '.omc', 'graph-runs');
    const fixturePath = join(workDir, 'descriptor.json');
    writeFileSync(fixturePath, JSON.stringify(descriptorInput('run-cli-crash', 'crash mapping')));
    mocks.runGraph.mockRejectedValueOnce(new Error('scheduler contract violated'));

    // Act
    await parseCli(['run', fixturePath, '--runs-root', runsRoot]);

    // Assert
    expect(process.exitCode).toBe(70);
    const stderr = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(stderr).toContain('[crash]');
    expect(stderr).toContain('scheduler contract violated');
  });

  it('reports a clean nonzero failure for a missing descriptor file', async () => {
    // Arrange
    const missingPath = join(workDir, 'nope.json');

    // Act
    await parseCli(['run', missingPath]);

    // Assert
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toContain(
      missingPath,
    );
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it('accepts Darwin as a supported confined runtime platform', async () => {
    const runsRoot = join(workDir, '.omc', 'graph-runs');
    const fixturePath = join(workDir, 'descriptor.json');
    writeFileSync(fixturePath, JSON.stringify(descriptorInput('run-darwin', 'darwin support')));
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    try {
      await parseCli(['run', fixturePath, '--runs-root', runsRoot]);
    } finally {
      platform.mockRestore();
    }

    expect(process.exitCode).toBe(EXIT_CODES.OK);
    expect(mocks.runGraph).toHaveBeenCalledOnce();
    expect(existsSync(runsRoot)).toBe(true);
  });
});
