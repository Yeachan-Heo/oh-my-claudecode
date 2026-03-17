import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { guidedAutoresearchSetupMock, spawnAutoresearchTmuxMock } = vi.hoisted(() => ({
  guidedAutoresearchSetupMock: vi.fn(),
  spawnAutoresearchTmuxMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock('../autoresearch-guided.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../autoresearch-guided.js')>();
  return {
    ...actual,
    guidedAutoresearchSetup: guidedAutoresearchSetupMock,
    spawnAutoresearchTmux: spawnAutoresearchTmuxMock,
  };
});

import { autoresearchCommand, normalizeAutoresearchClaudeArgs, parseAutoresearchArgs, AUTORESEARCH_HELP } from '../autoresearch.js';

describe('normalizeAutoresearchClaudeArgs', () => {
  it('adds permission bypass by default for autoresearch workers', () => {
    expect(normalizeAutoresearchClaudeArgs(['--model', 'opus'])).toEqual(['--model', 'opus', '--dangerously-skip-permissions']);
  });

  it('deduplicates explicit bypass flags', () => {
    expect(normalizeAutoresearchClaudeArgs(['--dangerously-skip-permissions'])).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('parseAutoresearchArgs', () => {
  it('defaults to interview-first guided mode with no args', () => {
    const parsed = parseAutoresearchArgs([]);
    expect(parsed.guided).toBe(true);
    expect(parsed.missionDir).toBeNull();
    expect(parsed.runId).toBeNull();
    expect(parsed.claudeArgs).toEqual([]);
  });

  it('parses bypass mode with mission and sandbox flags', () => {
    const parsed = parseAutoresearchArgs(['--mission', 'Improve onboarding', '--sandbox', 'npm run eval']);
    expect(parsed.missionDir).toBeNull();
    expect(parsed.runId).toBeNull();
    expect(parsed.missionText).toBe('Improve onboarding');
    expect(parsed.sandboxCommand).toBe('npm run eval');
    expect(parsed.keepPolicy).toBeUndefined();
    expect(parsed.slug).toBeUndefined();
  });

  it('parses bypass mode with optional keep-policy and slug', () => {
    const parsed = parseAutoresearchArgs([
      '--mission=Improve onboarding',
      '--sandbox=npm run eval',
      '--keep-policy=pass_only',
      '--slug',
      'My Mission',
    ]);
    expect(parsed.missionText).toBe('Improve onboarding');
    expect(parsed.sandboxCommand).toBe('npm run eval');
    expect(parsed.keepPolicy).toBe('pass_only');
    expect(parsed.slug).toBe('my-mission');
  });

  it('rejects mission without sandbox', () => {
    expect(() => parseAutoresearchArgs(['--mission', 'Improve onboarding'])).toThrow(/Both --mission and --sandbox are required together/);
  });

  it('rejects sandbox without mission', () => {
    expect(() => parseAutoresearchArgs(['--sandbox', 'npm run eval'])).toThrow(/Both --mission and --sandbox are required together/);
  });

  it('rejects positional arguments in bypass mode', () => {
    expect(() => parseAutoresearchArgs(['--mission', 'x', '--sandbox', 'y', 'missions/demo'])).toThrow(/Positional arguments are not supported/);
  });

  it('parses mission-dir as first positional argument', () => {
    const parsed = parseAutoresearchArgs(['/path/to/mission']);
    expect(parsed.missionDir).toBe('/path/to/mission');
    expect(parsed.runId).toBeNull();
    expect(parsed.claudeArgs).toEqual([]);
  });

  it('parses --resume with run-id', () => {
    const parsed = parseAutoresearchArgs(['--resume', 'my-run-id']);
    expect(parsed.missionDir).toBeNull();
    expect(parsed.runId).toBe('my-run-id');
  });

  it('parses --resume= with run-id', () => {
    const parsed = parseAutoresearchArgs(['--resume=my-run-id']);
    expect(parsed.missionDir).toBeNull();
    expect(parsed.runId).toBe('my-run-id');
  });

  it('parses --help', () => {
    const parsed = parseAutoresearchArgs(['--help']);
    expect(parsed.missionDir).toBe('--help');
    expect(AUTORESEARCH_HELP).toContain('Claude setup + background launch');
    expect(AUTORESEARCH_HELP).toMatch(/Partial bypass is invalid/);
  });

  it('parses init subcommand', () => {
    const parsed = parseAutoresearchArgs(['init', '--topic', 'my topic']);
    expect(parsed.guided).toBe(true);
    expect(parsed.initArgs).toEqual(['--topic', 'my topic']);
  });

  it('passes extra args as claudeArgs', () => {
    const parsed = parseAutoresearchArgs(['/path/to/mission', '--model', 'opus']);
    expect(parsed.missionDir).toBe('/path/to/mission');
    expect(parsed.claudeArgs).toEqual(['--model', 'opus']);
  });

  it('rejects flags before mission-dir', () => {
    expect(() => parseAutoresearchArgs(['--unknown-flag'])).toThrow(/mission-dir must be the first positional argument/);
  });
});


describe('autoresearchCommand', () => {
  beforeEach(() => {
    guidedAutoresearchSetupMock.mockReset();
    spawnAutoresearchTmuxMock.mockReset();
    vi.mocked(execFileSync).mockReset();
  });

  it('routes no-arg mode through guided setup then detached tmux handoff', async () => {
    vi.mocked(execFileSync).mockReturnValue('/repo\n' as never);
    guidedAutoresearchSetupMock.mockResolvedValue({
      missionDir: '/repo/missions/demo',
      slug: 'demo',
    });

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repo');

    try {
      await autoresearchCommand([]);
    } finally {
      cwdSpy.mockRestore();
    }

    expect(guidedAutoresearchSetupMock).toHaveBeenCalledWith('/repo');
    expect(spawnAutoresearchTmuxMock).toHaveBeenCalledWith('/repo/missions/demo', 'demo');
  });
});
