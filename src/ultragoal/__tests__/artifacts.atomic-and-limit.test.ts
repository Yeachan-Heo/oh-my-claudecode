import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { clearWorktreeCache } from '../../lib/worktree-paths.js';
import {
  addUltragoalGoal,
  createUltragoalPlan,
  deriveGoalCandidates,
  UltragoalError,
  ultragoalDir,
  ultragoalGoalsPath,
} from '../artifacts.js';

const control = vi.hoisted(() => ({
  failRenameNext: false,
  fixedUuid: undefined as string | undefined,
  // Mode of each temporary goals.json file as it exists when chmod is called on it (the moment the write is complete).
  tmpModesAtChmod: [] as number[],
}));

// Simulates a crash between the temporary write and the rename, records the mode of the temporary file before its chmod,
// and pins randomUUID when a test needs a known temporary name.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (String(args[0]).includes('.tmp.')) control.tmpModesAtChmod.push(statSync(String(args[0])).mode & 0o777);
      return actual.chmod(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (control.failRenameNext) {
        control.failRenameNext = false;
        throw new Error('simulated crash before rename');
      }
      return actual.rename(...args);
    },
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => control.fixedUuid ?? actual.randomUUID(),
  };
});

const MAX_CANDIDATES_ENV = 'OMC_ULTRAGOAL_MAX_CANDIDATES';
const PLAN_ID = 'test-plan';
const BRIEF = 'Atomic write test plan.\n- first test goal\n- second test goal\n';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omc-ultragoal-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalStateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
  delete process.env.OMC_STATE_DIR;
  clearWorktreeCache();
  try {
    return await run(cwd);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = originalStateDir;
    clearWorktreeCache();
    await rm(cwd, { recursive: true, force: true });
  }
}

function temporaryFiles(cwd: string): string[] {
  return readdirSync(ultragoalDir(cwd, PLAN_ID), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes('.tmp'))
    .map((entry) => entry.name)
    .sort();
}

async function readPlan(cwd: string): Promise<{ version: number; goals: Array<{ title: string }> }> {
  return JSON.parse(await readFile(ultragoalGoalsPath(cwd, PLAN_ID), 'utf-8'));
}

function bulletBrief(count: number): string {
  return Array.from({ length: count }, (_, index) => `- Goal number ${index + 1}`).join('\n');
}

// A loose list without bullets: paragraphs separated by a blank line (the second way goals are derived).
function paragraphBrief(count: number): string {
  return Array.from({ length: count }, (_, index) => `Paragraph ${index + 1} of the brief: something to do.`).join('\n\n');
}

describe('ultragoal goals.json atomic write', () => {
  beforeEach(() => {
    control.failRenameNext = false;
    control.fixedUuid = undefined;
  });

  afterEach(() => {
    control.failRenameNext = false;
    control.fixedUuid = undefined;
  });

  it('writes writePlan through a unique temporary file and rename, with cleanup on failure', () => {
    const source = readFileSync(fileURLToPath(new URL('../artifacts.ts', import.meta.url)), 'utf-8');
    const match = source.match(/async function writePlan\(cwd: string, plan: UltragoalPlan\): Promise<void> \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    const writePlan = match?.[0] ?? '';
    expect(writePlan).toMatch(/\brename\(/);
    expect(writePlan).toMatch(/writeFile\(\s*tmpPath,[\s\S]*flag: 'wx'/);
    expect(writePlan).toMatch(/`\$\{goalsPath\}\.tmp\.\$\{process\.pid\}\.\$\{randomUUID\(\)\}`/);
    expect(writePlan).toMatch(/catch \(error\) \{\s*await rm\(tmpPath, \{ force: true \}\);\s*throw error;\s*\}/);
    expect(source).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(source).toMatch(/import \{[^}]*\brename\b[^}]*\brm\b[^}]*\} from 'node:fs\/promises';/);
  });

  it('writes a new plan completely and leaves no temporary file behind', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });

      expect(existsSync(ultragoalGoalsPath(cwd, PLAN_ID))).toBe(true);
      const stored = await readPlan(cwd);
      expect(stored.version).toBe(1);
      expect(Array.isArray(stored.goals)).toBe(true);
      expect(stored.goals.length).toBe(plan.goals.length);
      expect(stored.goals.length).toBeGreaterThanOrEqual(2);
      expect(temporaryFiles(cwd)).toEqual([]);
    });
  });

  it('keeps parallel writes to the same plan from failing and leaves a valid goals.json', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });

      const settled = await Promise.allSettled([
        addUltragoalGoal(cwd, { planId: PLAN_ID, title: 'parallel test goal 1', objective: 'Parallel test goal number 1.' }),
        addUltragoalGoal(cwd, { planId: PLAN_ID, title: 'parallel test goal 2', objective: 'Parallel test goal number 2.' }),
        addUltragoalGoal(cwd, { planId: PLAN_ID, title: 'parallel test goal 3', objective: 'Parallel test goal number 3.' }),
      ]);

      const rejected = settled.filter((result) => result.status === 'rejected');
      expect(rejected.map((result) => (result as PromiseRejectedResult).reason?.message)).toEqual([]);
      const stored = await readPlan(cwd);
      expect(stored.version).toBe(1);
      expect(stored.goals.length).toBeGreaterThanOrEqual(3);
      expect(stored.goals.length).toBeLessThanOrEqual(5);
      expect(stored.goals.some((goal) => ['parallel test goal 1', 'parallel test goal 2', 'parallel test goal 3'].includes(goal.title))).toBe(true);
      expect(temporaryFiles(cwd)).toEqual([]);
    });
  });

  it('keeps the previous goals.json intact when the write is interrupted before the rename', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });
      const before = await readFile(ultragoalGoalsPath(cwd, PLAN_ID), 'utf-8');
      const countBefore = (await readPlan(cwd)).goals.length;

      control.failRenameNext = true;
      await expect(
        addUltragoalGoal(cwd, { planId: PLAN_ID, title: 'interrupted test goal', objective: 'Interrupted test goal.' }),
      ).rejects.toThrow('simulated crash before rename');

      expect(await readFile(ultragoalGoalsPath(cwd, PLAN_ID), 'utf-8')).toBe(before);
      expect((await readPlan(cwd)).goals.length).toBe(countBefore);
      expect(temporaryFiles(cwd)).toEqual([]);
    });
  });

  it('keeps goals.json intact when the temporary path cannot be written', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });
      const before = await readFile(ultragoalGoalsPath(cwd, PLAN_ID), 'utf-8');
      const countBefore = (await readPlan(cwd)).goals.length;

      // A directory on the exact temporary path makes the temporary write fail before any rename.
      control.fixedUuid = 'blocked-test-uuid';
      const blockedPath = `${ultragoalGoalsPath(cwd, PLAN_ID)}.tmp.${process.pid}.blocked-test-uuid`;
      mkdirSync(blockedPath);
      let failure: unknown = null;
      try {
        await addUltragoalGoal(cwd, { planId: PLAN_ID, title: 'blocked test goal', objective: 'Blocked test goal.' });
      } catch (error) {
        failure = error;
      }

      expect(failure).not.toBeNull();
      expect(await readFile(ultragoalGoalsPath(cwd, PLAN_ID), 'utf-8')).toBe(before);
      expect((await readPlan(cwd)).goals.length).toBe(countBefore);
    });
  });

  it('is not affected by a truncated temporary file left by another writer', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });
      const leftover = `${ultragoalGoalsPath(cwd, PLAN_ID)}.tmp.999999.interrupted-other-writer`;
      writeFileSync(leftover, '{"version": 1, "goals": [{"id":"');

      const { plan } = await addUltragoalGoal(cwd, { planId: PLAN_ID, title: 'third test goal', objective: 'Third test goal.' });

      const stored = await readPlan(cwd);
      expect(stored.goals.length).toBe(plan.goals.length);
      expect(stored.goals.some((goal) => goal.title === 'third test goal')).toBe(true);
    });
  });
});

describe.skipIf(process.platform === 'win32')('ultragoal goals.json permissions', () => {
  beforeEach(() => {
    control.failRenameNext = false;
    control.fixedUuid = undefined;
    control.tmpModesAtChmod.length = 0;
  });

  it('keeps the permissions of an existing goals.json across the atomic write', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });
      const goalsPath = ultragoalGoalsPath(cwd, PLAN_ID);

      // 0o600 is narrower and 0o664 wider than the 0o644 a default umask gives a new file.
      for (const mode of [0o600, 0o664]) {
        chmodSync(goalsPath, mode);
        await addUltragoalGoal(cwd, { planId: PLAN_ID, title: `goal for mode ${mode.toString(8)}`, objective: 'Mode test goal.' });
        expect(statSync(goalsPath).mode & 0o777).toBe(mode);
      }
      expect(temporaryFiles(cwd)).toEqual([]);
    });
  });

  it('creates the temporary file with the mode of the goals.json it replaces, never wider', async () => {
    // Under a umask of 0o022 the default mode of a new file (0o644) is wider than both modes below; fix the umask where the
    // runner allows it, so that the check cannot pass by accident.
    let previousUmask: number | undefined;
    try {
      previousUmask = process.umask(0o022);
    } catch {
      /* a worker thread cannot change the umask */
    }
    try {
      await withTempRepo(async (cwd) => {
        await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });
        const goalsPath = ultragoalGoalsPath(cwd, PLAN_ID);

        for (const mode of [0o600, 0o640]) {
          chmodSync(goalsPath, mode);
          control.tmpModesAtChmod.length = 0;
          await addUltragoalGoal(cwd, { planId: PLAN_ID, title: `goal for mode ${mode.toString(8)}`, objective: 'Mode test goal.' });
          expect(control.tmpModesAtChmod).toHaveLength(1);
          // Every permission bit of the temporary file is also set on the file it replaces.
          expect(control.tmpModesAtChmod[0] & ~mode).toBe(0);
          expect(statSync(goalsPath).mode & 0o777).toBe(mode);
        }
      });
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask);
    }
  });

  it('gives a new goals.json the default mode of a newly created file', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { planId: PLAN_ID, brief: BRIEF });
      const reference = join(ultragoalDir(cwd, PLAN_ID), 'default-mode-reference');
      writeFileSync(reference, 'reference');

      expect(statSync(ultragoalGoalsPath(cwd, PLAN_ID)).mode & 0o777).toBe(statSync(reference).mode & 0o777);
    });
  });
});

describe('ultragoal implicit candidate limit', () => {
  let originalLimit: string | undefined;

  beforeEach(() => {
    originalLimit = process.env[MAX_CANDIDATES_ENV];
  });

  afterEach(() => {
    if (originalLimit === undefined) delete process.env[MAX_CANDIDATES_ENV];
    else process.env[MAX_CANDIDATES_ENV] = originalLimit;
  });

  it('does not limit candidates when the variable is unset', async () => {
    delete process.env[MAX_CANDIDATES_ENV];
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: bulletBrief(25) });
      expect(plan.goals).toHaveLength(25);
    });
  });

  it('does not limit candidates when the variable is 0', async () => {
    process.env[MAX_CANDIDATES_ENV] = '0';
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: bulletBrief(25) });
      expect(plan.goals).toHaveLength(25);
    });
  });

  it('accepts exactly the limit', async () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: bulletBrief(20) });
      expect(plan.goals).toHaveLength(20);
    });
  });

  it('refuses one candidate above the limit, names the count and the limit, and writes nothing', async () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    await withTempRepo(async (cwd) => {
      const error = await createUltragoalPlan(cwd, { brief: bulletBrief(21) }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UltragoalError);
      expect((error as Error).message).toContain('21 goal candidates');
      expect((error as Error).message).toContain('20');
      expect((error as Error).message).toContain('--goal');
      expect(existsSync(ultragoalGoalsPath(cwd))).toBe(false);
      expect(existsSync(join(ultragoalDir(cwd), 'brief.md'))).toBe(false);
    });
  });

  it('never limits explicit goals', async () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    await withTempRepo(async (cwd) => {
      const goals = Array.from({ length: 21 }, (_, index) => ({ title: `Goal ${index + 1}`, objective: `Do thing ${index + 1}` }));
      const plan = await createUltragoalPlan(cwd, { brief: bulletBrief(21), goals });
      expect(plan.goals).toHaveLength(21);
    });
  });

  it('never limits a larger set of explicit goals', async () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    await withTempRepo(async (cwd) => {
      const goals = Array.from({ length: 25 }, (_, index) => ({ objective: `Explicit goal ${index + 1}` }));
      const plan = await createUltragoalPlan(cwd, { brief: bulletBrief(21), goals });
      expect(plan.goals).toHaveLength(25);
      expect(plan.goals[0]?.objective).toBe('Explicit goal 1');
    });
  });

  it('accepts exactly 20 and refuses 21 candidates derived from a loose bullet list', () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    const candidates = deriveGoalCandidates(bulletBrief(20));
    expect(candidates).toHaveLength(20);
    expect(candidates[0]?.objective).toBe('Goal number 1');
    expect(() => deriveGoalCandidates(bulletBrief(21))).toThrow(UltragoalError);
    expect(() => deriveGoalCandidates(bulletBrief(21))).toThrow(/21 goal candidates/);
  });

  it('accepts exactly 20 and refuses 21 candidates derived from paragraphs', () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    expect(deriveGoalCandidates(paragraphBrief(20))).toHaveLength(20);
    let failure: unknown = null;
    try {
      deriveGoalCandidates(paragraphBrief(21));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UltragoalError);
    expect((failure as Error).message).toContain('21 goal candidates');
    expect((failure as Error).message).toContain('20');
  });

  it('does not count headings or non-goal lines against the limit', () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    const headings = '# Plan\n\n## Background\n\n';
    expect(deriveGoalCandidates(`${headings}${paragraphBrief(20)}`)).toHaveLength(20);
    // With a bullet list present only the bullets are goals; the prose around them is not counted.
    expect(deriveGoalCandidates(`Intro line.\n\n${bulletBrief(20)}\n\nClosing remark.`)).toHaveLength(20);
  });

  it('leaves an empty brief to the existing empty-list path', () => {
    process.env[MAX_CANDIDATES_ENV] = '20';
    expect(deriveGoalCandidates('')).toHaveLength(1);
  });

  it.each(['abc', '-3', ''])('does not limit candidates when the variable is %j', (value) => {
    process.env[MAX_CANDIDATES_ENV] = value;
    expect(deriveGoalCandidates(bulletBrief(25))).toHaveLength(25);
  });
});
