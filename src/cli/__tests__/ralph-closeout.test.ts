import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ralphCloseout, ralphVerify, evaluateCloseoutGate } from '../commands/ralph.js';
import { getStoryGoverningCriteriaRevision } from '../../hooks/ralph/prd.js';
import { closeoutPath } from '../../hooks/ralph/closeout.js';

const tempRoots: string[] = [];
const SESSION = 'session-closeout-gate';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-ralph-closeout-gate-'));
  // Anchor the OMC root: without a marker getOmcRoot walks past the fixture.
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.OMC_SESSION_ID;
});

interface StoryOptions {
  passes: boolean;
  architectVerified?: boolean;
}

function writePrd(directory: string, stories: StoryOptions[]): void {
  const userStories = stories.map((options, index) => {
    const acceptanceCriteria = [`story ${index + 1} accepts its result`];
    const revision = getStoryGoverningCriteriaRevision({ acceptanceCriteria, criterionAmendments: undefined });
    return {
      id: `US-${index + 1}`,
      title: `Story ${index + 1}`,
      description: 'test story',
      acceptanceCriteria,
      priority: index + 1,
      passes: options.passes,
      ...(options.passes ? { completionCriteriaRevision: revision } : {}),
      ...(options.passes && options.architectVerified === true
        ? { architectVerified: true, architectVerificationCriteriaRevision: revision }
        : {}),
    };
  });

  const prdDir = join(directory, '.omc', 'state', 'sessions', SESSION);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(join(prdDir, 'prd.json'), JSON.stringify({
    project: 'closeout-gate',
    branchName: 'main',
    description: 'closeout gate fixture',
    // A command that exits 0 everywhere and prints nothing, so the only
    // variable under test is the closeout record.
    feedbackCommands: ['node -e "process.exit(0)"'],
    userStories,
  }, null, 2));
}

function capture<T>(fn: () => T): { code: T; output: string } {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = fn();
    return { code, output: [...log.mock.calls, ...error.mock.calls].map((args) => args.join(' ')).join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('omc ralph verify closeout gate', () => {
  it('fails a complete PRD that has no closeout record', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }]);

    const { code, output } = capture(() => ralphVerify({ session: SESSION }, directory, new Date()));

    expect(code).toBe(1);
    expect(output).toContain('closeout record');
    expect(output).toContain('omc ralph closeout --deslop');
  });

  it('passes once a matching closeout record is written', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }]);
    capture(() => ralphVerify({ session: SESSION, writeBaseline: true }, directory, new Date()));

    const recorded = capture(() => ralphCloseout({ session: SESSION, deslop: 'completed' }, directory, new Date()));
    expect(recorded.code).toBe(0);

    const { code, output } = capture(() => ralphVerify({ session: SESSION }, directory, new Date()));
    expect(code).toBe(0);
    expect(output).toContain('closeout recorded');
  });

  it('accepts an explicitly skipped deslop pass', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }]);
    capture(() => ralphCloseout({ session: SESSION, deslop: 'skipped' }, directory, new Date()));

    expect(capture(() => ralphVerify({ session: SESSION }, directory, new Date())).code).toBe(0);
  });

  it('does not gate a PRD whose stories still await approval', () => {
    const directory = workspace();
    // passes but not architect-verified: Ralph does not consider this complete,
    // so the terminal gate must stay open.
    writePrd(directory, [{ passes: true, architectVerified: false }]);

    expect(capture(() => ralphVerify({ session: SESSION }, directory, new Date())).code).toBe(0);
  });

  it('does not gate a run with an incomplete story', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }, { passes: false }]);

    expect(capture(() => ralphVerify({ session: SESSION }, directory, new Date())).code).toBe(0);
  });

  it('invalidates the record when the acceptance criteria change afterwards', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }]);
    capture(() => ralphVerify({ session: SESSION, writeBaseline: true }, directory, new Date()));
    capture(() => ralphCloseout({ session: SESSION, deslop: 'completed' }, directory, new Date()));

    // Amend the criterion and re-complete the story against the new revision:
    // the run is complete again, but the recorded closeout describes work that
    // was verified against the old criteria.
    const prdPath = join(directory, '.omc', 'state', 'sessions', SESSION, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    const acceptanceCriteria = ['a materially different criterion'];
    const revision = getStoryGoverningCriteriaRevision({ acceptanceCriteria, criterionAmendments: undefined });
    Object.assign(prd.userStories[0], {
      acceptanceCriteria,
      completionCriteriaRevision: revision,
      architectVerificationCriteriaRevision: revision,
    });
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));

    const { code, output } = capture(() => ralphVerify({ session: SESSION }, directory, new Date()));
    expect(code).toBe(1);
    expect(output).toContain('closeout record');
  });

  it('refuses to record a closeout before every story is complete', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: false }]);

    const { code, output } = capture(() => ralphCloseout({ session: SESSION, deslop: 'completed' }, directory, new Date()));
    expect(code).toBe(1);
    expect(output).toContain('incomplete stories');
  });

  it('refuses an unknown deslop status', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }]);

    const { code, output } = capture(() => ralphCloseout({ session: SESSION, deslop: 'maybe' }, directory, new Date()));
    expect(code).toBe(1);
    expect(output).toContain('--deslop completed or --deslop skipped');
  });

  it('does not gate a run without a session, because the record is session-scoped', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }]);

    expect(evaluateCloseoutGate(directory, join(directory, '.omc'), '')).toMatchObject({
      required: false,
      satisfied: true,
    });
  });

  it('reports the check action without writing', () => {
    const directory = workspace();
    writePrd(directory, [{ passes: true, architectVerified: true }]);
    const record = closeoutPath(join(directory, '.omc'), SESSION);

    expect(capture(() => ralphCloseout({ session: SESSION, check: true }, directory, new Date())).code).toBe(1);
    expect(existsSync(record)).toBe(false);

    capture(() => ralphCloseout({ session: SESSION, deslop: 'completed' }, directory, new Date()));
    expect(capture(() => ralphCloseout({ session: SESSION, check: true }, directory, new Date())).code).toBe(0);
  });
});
