import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import {
  buildAutoresearchSetupPrompt,
  collectAutoresearchRepoSignals,
  runAutoresearchSetupSession,
} from '../autoresearch-setup-session.js';

describe('collectAutoresearchRepoSignals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects generic repo signals from package.json and mission examples', () => {
    const repo = mkdtempSync(join(tmpdir(), 'omc-autoresearch-signals-'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc --noEmit' } }), 'utf-8');
    mkdirSync(join(repo, 'missions', 'demo'), { recursive: true });
    writeFileSync(join(repo, 'missions', 'demo', 'sandbox.md'), '---\nevaluator:\n  command: npm run test\n  format: json\n---\n', 'utf-8');

    const signals = collectAutoresearchRepoSignals(repo);

    expect(signals.lines).toContain('package.json script test: vitest run');
    expect(signals.lines).toContain('existing mission example: missions/demo');
    expect(signals.lines).toContain('existing mission evaluator: npm run test');
  });
});

describe('buildAutoresearchSetupPrompt', () => {
  it('includes repo signals and clarification answers', () => {
    const prompt = buildAutoresearchSetupPrompt({
      repoRoot: '/repo',
      missionText: 'Improve search relevance',
      clarificationAnswers: ['Prefer evaluator based on vitest smoke tests'],
      repoSignals: { lines: ['package.json script test: vitest run'] },
    });

    expect(prompt).toContain('Mission request: Improve search relevance');
    expect(prompt).toContain('Clarification 1: Prefer evaluator based on vitest smoke tests');
    expect(prompt).toContain('package.json script test: vitest run');
  });
});

describe('runAutoresearchSetupSession', () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('parses validated JSON from claude print mode', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"missionText":"Improve launch flow","evaluatorCommand":"npm run test:run -- launch","evaluatorSource":"inferred","confidence":0.86,"slug":"launch-flow","readyToLaunch":true}',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const result = runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Improve launch flow' });

    expect(result.slug).toBe('launch-flow');
    expect(result.readyToLaunch).toBe(true);
    expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe('claude');
    expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toEqual(['-p', expect.any(String)]);
  });

  it('fails when claude returns non-zero', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 2,
      stdout: '',
      stderr: 'bad',
      pid: 1,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(() => runAutoresearchSetupSession({ repoRoot: '/repo', missionText: 'Improve launch flow' })).toThrow(/claude_autoresearch_setup_failed:2/);
  });
});
