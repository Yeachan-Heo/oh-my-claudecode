import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addUltragoalGoal,
  buildClaudeGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  isUltragoalDone,
  readUltragoalPlan,
  recordFinalReviewBlockers,
  startNextUltragoal,
} from '../artifacts.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omc-ultragoal-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function cleanQualityGate(): object {
  return {
    aiSlopCleaner: { status: 'passed', evidence: 'ai-slop-cleaner ran on changed files' },
    verification: { status: 'passed', commands: ['npm test'], evidence: 'tests passed after cleaner' },
    codeReview: { recommendation: 'APPROVE', architectStatus: 'CLEAR', evidence: '$code-review approved with CLEAR architecture' },
  };
}

describe('ultragoal artifacts', () => {
  it('creates brief, goals, and ledger artifacts under .omc/ultragoal', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Build the CLI\n- Add tests\n- Write docs',
        now: new Date('2026-05-04T10:00:00Z'),
      });

      expect(plan.goals.length).toBe(3);
      expect(plan.claudeGoalMode).toBe('aggregate');
      expect(plan.claudeObjective ?? '').toMatch(/Complete all ultragoal stories/);
      expect(plan.claudeObjective ?? '').toMatch(/G001-build-the-cli/);
      expect(plan.goals[0]?.id).toBe('G001-build-the-cli');
      expect(plan.goals[0]?.status).toBe('pending');
      expect(plan.briefPath).toBe('.omc/ultragoal/brief.md');
      expect(plan.goalsPath).toBe('.omc/ultragoal/goals.json');
      expect(plan.ledgerPath).toBe('.omc/ultragoal/ledger.jsonl');
      expect(await readFile(join(cwd, '.omc/ultragoal/brief.md'), 'utf-8')).toBe('- Build the CLI\n- Add tests\n- Write docs\n');

      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect(ledger).toMatch(/"event":"plan_created"/);
    });
  });

  it('starts one story at a time and emits an aggregate Claude /goal handoff by default', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const started = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:01:00Z') });
      expect(started.goal?.id).toBe('G001-first');
      expect(started.goal?.status).toBe('in_progress');
      expect(started.plan.activeGoalId).toBe('G001-first');

      const resumed = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:02:00Z') });
      expect(resumed.goal?.id).toBe('G001-first');
      expect(resumed.resumed).toBe(true);

      const instruction = buildClaudeGoalInstruction(started.goal!, started.plan);
      expect(instruction).toMatch(/active Claude \/goal condition/i);
      expect(instruction).toMatch(/invoke \/goal/i);
      expect(instruction).toMatch(/Claude \/goal = the whole ultragoal run/i);
      expect(instruction).toMatch(/same aggregate objective as active/i);
      expect(instruction).toMatch(/do not clear the \/goal yet/i);
      expect(instruction).not.toMatch(/fresh Claude Code session/i);
      expect(instruction).toMatch(/--claude-goal-json/);
      expect(instruction).toMatch(/Complete all ultragoal stories/);
      expect(instruction).toMatch(/Complete first milestone/);
      expect(instruction).not.toMatch(/get_goal/);
      expect(instruction).not.toMatch(/create_goal/);
      expect(instruction).not.toMatch(/update_goal/);
      expect(instruction).not.toMatch(/\bcodex\b/i);
    });
  });

  it('checkpoints success, advances, and supports failed-goal retry', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.claudeObjective!;
      await expect(
        checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'premature aggregate completion',
          claudeGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        }),
      ).rejects.toThrow(/expected active/);
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'unit tests passed',
        claudeGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });
      const second = await startNextUltragoal(cwd);
      expect(second.goal?.id).toBe('G002-second');

      await expect(
        checkpointUltragoal(cwd, {
          goalId: second.goal!.id,
          status: 'complete',
          evidence: 'not final yet',
          claudeGoal: { goal: { objective: aggregateObjective, status: 'active' } },
        }),
      ).rejects.toThrow(/not complete/);

      await checkpointUltragoal(cwd, { goalId: second.goal!.id, status: 'failed', evidence: 'blocked' });
      const noPending = await startNextUltragoal(cwd);
      expect(noPending.goal).toBeNull();
      expect(noPending.done).toBe(false);

      const retry = await startNextUltragoal(cwd, { retryFailed: true });
      expect(retry.goal?.id).toBe('G002-second');
      expect(retry.goal?.status).toBe('in_progress');
      expect(retry.goal?.attempt).toBe(2);

      const plan = await readUltragoalPlan(cwd);
      expect(plan.goals[0]?.evidence).toBe('unit tests passed');
      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect(ledger).toMatch(/"event":"goal_completed"/);
      expect(ledger).toMatch(/"event":"goal_failed"/);
      expect(ledger).toMatch(/"event":"goal_retried"/);
    });
  });

  it('reconciles completed task-scoped Claude snapshot to finish exploded aggregate ultragoal bookkeeping', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix the mismatch between Claude immutable completed /goal snapshots and OMC ultragoal checkpoint reconciliation.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: Array.from({ length: 136 }, (_, index) => ({
          title: `Micro goal ${index + 1}`,
          objective: `Synthetic bookkeeping slice ${index + 1}.`,
        })),
      });

      const first = await startNextUltragoal(cwd);
      expect(first.goal?.id).toBe('G001-micro-goal-1');

      const reconciled = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'Actual planned work done for .omc/ultragoal/goals.json G001-micro-goal-1; validation complete; reviews clean.',
        claudeGoal: { goal: { objective: taskObjective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
        now: new Date('2026-05-04T10:04:00Z'),
      });

      expect(reconciled.goals.length).toBe(136);
      expect(reconciled.goals.filter((goal) => goal.status === 'complete').length).toBe(0);
      expect(reconciled.goals[0]?.status).toBe('in_progress');
      expect(reconciled.activeGoalId).toBeUndefined();
      expect(reconciled.aggregateCompletion?.status).toBe('complete');
      expect(reconciled.aggregateCompletion?.evidence ?? '').toMatch(/planned work done/);
      expect(isUltragoalDone(reconciled)).toBe(true);

      const next = await startNextUltragoal(cwd);
      expect(next.goal).toBeNull();
      expect(next.done).toBe(true);

      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect(ledger).toMatch(/microgoal ledger progress remains independent/);
      expect((ledger.match(/"event":"aggregate_completed"/g) ?? []).length).toBe(1);
      expect((ledger.match(/"event":"goal_completed"/g) ?? []).length).toBe(0);
    });
  });

  it('fails closed for task-scoped aggregate completion without plan mapping or evidence', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Implement the reconciler fix described in the approved ultragoal brief.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [
          { title: 'First', objective: 'Synthetic slice 1.' },
          { title: 'Second', objective: 'Synthetic slice 2.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await expect(
        checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omc/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          claudeGoal: { goal: { objective: 'Unrelated completed task', status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
      ).rejects.toThrow(/objective mismatch/);

      await expect(
        checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'done',
          claudeGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
      ).rejects.toThrow(/Completed task-scoped aggregate reconciliation requires .*active in-progress/);

      await expect(
        checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omc/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          claudeGoal: { goal: { objective: taskObjective, status: 'complete' } },
        }),
      ).rejects.toThrow(/quality-gate-json|quality gate/i);
    });
  });

  it('fails closed for task-scoped aggregate completion on a non-active microgoal id', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix the mismatch between Claude immutable completed /goal snapshots and OMC ultragoal checkpoint reconciliation.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [
          { title: 'First', objective: 'Synthetic slice 1.' },
          { title: 'Second', objective: 'Synthetic slice 2.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.claudeObjective!;
      expect(first.goal?.id).toBe('G001-first');
      expect(first.plan.activeGoalId).toBe('G001-first');

      await expect(
        checkpointUltragoal(cwd, {
          goalId: 'G002-second',
          status: 'complete',
          evidence: 'second audit passed out of order',
          claudeGoal: { goal: { objective: aggregateObjective, status: 'active' } },
        }),
      ).rejects.toThrow(/Cannot record a complete checkpoint for G002-second while it is pending/);

      await expect(
        checkpointUltragoal(cwd, { goalId: 'G002-second', status: 'failed', evidence: 'failed out of order' }),
      ).rejects.toThrow(/Cannot record a failed checkpoint for G002-second while it is pending/);

      await expect(
        checkpointUltragoal(cwd, {
          goalId: 'G002-second',
          status: 'complete',
          evidence: 'Actual planned work done for .omc/ultragoal/goals.json G002-second; validation complete; reviews clean.',
          claudeGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
      ).rejects.toThrow(/Cannot record a complete checkpoint for G002-second while it is pending/);

      const plan = await readUltragoalPlan(cwd);
      expect(plan.activeGoalId).toBe('G001-first');
      expect(plan.aggregateCompletion).toBeUndefined();
      expect(plan.goals.find((goal) => goal.id === 'G001-first')?.status).toBe('in_progress');
      expect(plan.goals.find((goal) => goal.id === 'G002-second')?.status).toBe('pending');

      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect((ledger.match(/"event":"aggregate_completed"/g) ?? []).length).toBe(0);
    });
  });

  it('requires aggregate Claude /goal completion only for the final story', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.claudeObjective!;
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'first audit passed',
        claudeGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });

      const second = await startNextUltragoal(cwd);
      await checkpointUltragoal(cwd, {
        goalId: second.goal!.id,
        status: 'complete',
        evidence: 'final audit passed',
        claudeGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      expect(plan.goals.every((goal) => goal.status === 'complete')).toBe(true);
      expect(plan.activeGoalId).toBeUndefined();
    });
  });

  it('treats existing v1 plans without mode metadata as legacy per-story plans', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        claudeGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });
      delete created.claudeGoalMode;
      delete created.claudeObjective;
      await writeFile(join(cwd, '.omc/ultragoal/goals.json'), `${JSON.stringify(created, null, 2)}\n`);

      const first = await startNextUltragoal(cwd);
      const instruction = buildClaudeGoalInstruction(first.goal!, first.plan);
      expect(instruction).toMatch(/Ultragoal active-goal handoff/);
      expect(instruction).toMatch(/fresh Claude Code session/);

      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'legacy per-story audit passed',
        claudeGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      expect(plan.goals[0]?.status).toBe('complete');
    });
  });

  it('appends goals without changing the stored aggregate objective', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });
      const objective = plan.claudeObjective;
      const added = await addUltragoalGoal(cwd, {
        title: 'Resolve final code-review blockers',
        objective: 'Fix review blockers and rerun final gates.',
        evidence: 'review findings',
      });

      expect(added.goal.id).toBe('G002-resolve-final-code-review-blockers');
      expect(added.goal.status).toBe('pending');
      expect(added.plan.claudeObjective).toBe(objective);

      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect(ledger).toMatch(/"event":"goal_added"/);
    });
  });

  it('records final aggregate review blockers atomically and starts the blocker next', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.claudeObjective!;

      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-review REQUEST CHANGES',
        claudeGoal: { goal: { objective, status: 'active' } },
      });

      expect(result.blockedGoal.status).toBe('review_blocked');
      expect(result.addedGoal.status).toBe('pending');
      expect(result.plan.activeGoalId).toBeUndefined();
      expect(result.plan.claudeObjective).toBe(objective);

      const next = await startNextUltragoal(cwd);
      expect(next.goal?.id).toBe(result.addedGoal.id);

      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect(ledger).toMatch(/"event":"final_review_failed"/);
      expect(ledger).toMatch(/"event":"goal_review_blocked"/);
    });
  });

  it('records final per-story review blockers without claiming Claude /goal completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        claudeGoalMode: 'per_story',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers in a fresh goal context.',
        evidence: 'architect BLOCK',
        claudeGoal: { goal: { objective: started.goal!.objective, status: 'active' } },
      });

      expect(result.blockedGoal.status).toBe('review_blocked');
      expect(result.addedGoal.status).toBe('pending');
      expect(isUltragoalDone(result.plan)).toBe(false);
    });
  });

  it('requires structured final quality gate evidence for clean completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.claudeObjective!;

      await expect(
        checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          claudeGoal: { goal: { objective, status: 'complete' } },
        }),
      ).rejects.toThrow(/quality-gate-json|quality gate/i);

      await expect(
        checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          claudeGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: { recommendation: 'COMMENT', architectStatus: 'CLEAR', evidence: 'not clean' },
          },
        }),
      ).rejects.toThrow(/APPROVE/);

      await expect(
        checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          claudeGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            aiSlopCleaner: { status: 'not_applicable', evidence: 'skipped cleaner' },
          },
        }),
      ).rejects.toThrow(/aiSlopCleaner\.status="passed"/);

      await checkpointUltragoal(cwd, {
        goalId: started.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        claudeGoal: { goal: { objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      const plan = await readUltragoalPlan(cwd);
      expect(isUltragoalDone(plan)).toBe(true);
      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect(ledger).toMatch(/"qualityGate"/);
      expect(ledger).toMatch(/"aiSlopCleaner"/);
      expect(ledger).toMatch(/"codeReview"/);
    });
  });

  it('records a completed legacy Claude-goal blocker without failing the active ultragoal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        claudeGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const blocked = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence: 'completed aggregate Claude /goal blocks new /goal',
        claudeGoal: { goal: { objective: 'achieve all goals on this repo ultragoal status', status: 'complete' } },
        now: new Date('2026-05-04T10:03:00Z'),
      });

      expect(blocked.activeGoalId).toBe(first.goal!.id);
      expect(blocked.goals[0]?.status).toBe('in_progress');
      expect(blocked.goals[0]?.failureReason).toBeUndefined();
      expect(blocked.goals[0]?.failedAt).toBeUndefined();

      const ledger = await readFile(join(cwd, '.omc/ultragoal/ledger.jsonl'), 'utf-8');
      expect(ledger).toMatch(/"event":"goal_blocked"/);
      expect(ledger).toMatch(/completed aggregate Claude \/goal blocks new \/goal/);
    });
  });

  it('guides different completed legacy snapshots to blocked checkpoints and fresh sessions', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        claudeGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await expect(
        checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'audit passed but wrong Claude /goal snapshot',
          claudeGoal: { goal: { objective: 'Completed legacy objective', status: 'complete' } },
        }),
      ).rejects.toThrow(/objective mismatch[\s\S]*--status blocked[\s\S]*fresh Claude Code session/);
    });
  });

  it('rejects blocked checkpoints for active or same-objective Claude goals', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        claudeGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await expect(
        checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'active wrong goal',
          claudeGoal: { goal: { objective: 'Different active work', status: 'active' } },
        }),
      ).rejects.toThrow(/strict objective mismatch protection remains required/);

      await expect(
        checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'same complete goal',
          claudeGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        }),
      ).rejects.toThrow(/different completed legacy Claude goal/);
    });
  });
});
