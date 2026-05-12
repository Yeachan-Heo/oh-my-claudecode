import { readFile } from 'node:fs/promises';
import {
  ClaudeGoalSnapshotError,
  formatClaudeGoalReconciliation,
  readClaudeGoalSnapshotInput,
  reconcileClaudeGoalSnapshot,
} from '../../goal-workflows/claude-goal-snapshot.js';
import {
  addUltragoalGoal,
  buildClaudeGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  readUltragoalPlan,
  recordFinalReviewBlockers,
  startNextUltragoal,
  summarizeUltragoalPlan,
  type UltragoalItem,
  UltragoalError,
} from '../../ultragoal/artifacts.js';

export const ULTRAGOAL_HELP = `omc ultragoal - Durable repo-native multi-goal workflow with Claude Code /goal handoff

Usage:
  omc ultragoal create-goals [--brief <text> | --brief-file <path> | --from-stdin] [--goal <title::objective>] [--claude-goal-mode <aggregate|per-story>] [--force] [--json]
  omc ultragoal complete-goals [--retry-failed] [--json]
  omc ultragoal add-goal --title <title> --objective <text> [--evidence <text>] [--json]
  omc ultragoal record-review-blockers --goal-id <id> --title <title> --objective <text> --evidence <review-findings> --claude-goal-json <active-json-or-path> [--json]
  omc ultragoal checkpoint --goal-id <id> --status <complete|failed|blocked> [--evidence <text>] [--claude-goal-json <json-or-path>] [--quality-gate-json <json-or-path>] [--json]
  omc ultragoal status [--claude-goal-json <json-or-path>] [--json]

Aliases:
  create -> create-goals, complete|next|start-next -> complete-goals

Artifacts:
  .omc/ultragoal/brief.md
  .omc/ultragoal/goals.json
  .omc/ultragoal/ledger.jsonl

Claude /goal integration:
  This command cannot directly invoke the Claude Code /goal slash command from a shell;
  /goal is a model-facing in-session directive that registers a session-scoped Stop hook
  until its condition holds (auto-clears on success). complete-goals writes durable state
  and prints a model-facing handoff that tells the active Claude agent when to invoke
  /goal <condition>, when to clear it, and what snapshot JSON to share back.
  New plans default to aggregate mode: one Claude /goal covers the whole ultragoal run
  while OMC checkpoints G001/G002 stories in the durable ledger.
  Final completion is mandatory-gated: run ai-slop-cleaner, rerun verification,
  run $code-review, and pass --quality-gate-json with APPROVE + CLEAR evidence.
  Non-clean final review must use record-review-blockers before clearing the /goal.
`;

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function readValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readRepeated(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  const prefix = `${flag}=`;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    } else if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
    }
  }
  return values;
}

function parseGoalArg(raw: string): { title?: string; objective: string; tokenBudget?: number } {
  const [title, ...rest] = raw.split('::');
  if (rest.length === 0) return { objective: raw.trim() };
  return { title: title.trim(), objective: rest.join('::').trim() };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

function positionalText(args: readonly string[]): string {
  const valueTaking = new Set(['--brief', '--brief-file', '--goal', '--goal-id', '--status', '--evidence', '--claude-goal-json', '--claude-goal-mode', '--title', '--objective', '--quality-gate-json']);
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueTaking.has(arg)) { i += 1; continue; }
    if (arg.startsWith('--')) continue;
    words.push(arg);
  }
  return words.join(' ').trim();
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function normalizeClaudeGoalMode(raw: string | undefined): 'aggregate' | 'per_story' | undefined {
  if (!raw) return undefined;
  if (raw === 'aggregate') return 'aggregate';
  if (raw === 'per-story' || raw === 'per_story') return 'per_story';
  throw new UltragoalError('Invalid --claude-goal-mode; expected aggregate or per-story.');
}

function printStatus(plan: Awaited<ReturnType<typeof readUltragoalPlan>>): void {
  const summary = summarizeUltragoalPlan(plan);
  if (summary.aggregateComplete) {
    console.log('ultragoal aggregate product: complete');
    console.log(`microgoal ledger bookkeeping (progress-only): ${summary.complete}/${summary.total} complete, ${summary.pending} pending, ${summary.inProgress} in progress, ${summary.failed} failed, ${summary.reviewBlocked} review-blocked`);
  } else {
    console.log(`ultragoal: ${summary.complete}/${summary.total} complete, ${summary.pending} pending, ${summary.inProgress} in progress, ${summary.failed} failed, ${summary.reviewBlocked} review-blocked`);
  }
  for (const goal of plan.goals) {
    const marker = goal.id === plan.activeGoalId ? '*' : '-';
    console.log(`${marker} ${goal.id} [${goal.status}] ${goal.title}`);
  }
}

async function parseClaudeGoalJson(raw: string | undefined): Promise<unknown> {
  if (!raw) return undefined;
  return readClaudeGoalSnapshotInput(raw, process.cwd());
}

async function readJsonInput(raw: string | undefined): Promise<unknown> {
  if (!raw) return undefined;
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    return JSON.parse(await readFile(trimmed, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UltragoalError(`Invalid --quality-gate-json: ${message}`);
  }
}

export async function ultragoalCommand(args: string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const rest = args.slice(1);
  const json = hasFlag(rest, '--json');
  const cwd = process.cwd();

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(ULTRAGOAL_HELP);
      return;
    }

    if (command === 'create' || command === 'create-goals') {
      const briefFile = readValue(rest, '--brief-file');
      const brief = readValue(rest, '--brief')
        ?? (briefFile ? await readFile(briefFile, 'utf-8') : undefined)
        ?? (hasFlag(rest, '--from-stdin') ? await readStdin() : undefined)
        ?? positionalText(rest);
      if (!brief.trim()) throw new UltragoalError('Missing brief text. Pass --brief, --brief-file, --from-stdin, or positional text.');
      const goals = readRepeated(rest, '--goal').map(parseGoalArg);
      const plan = await createUltragoalPlan(cwd, {
        brief,
        goals,
        claudeGoalMode: normalizeClaudeGoalMode(readValue(rest, '--claude-goal-mode')),
        force: hasFlag(rest, '--force'),
      });
      if (json) printJson({ ok: true, plan, summary: summarizeUltragoalPlan(plan) });
      else {
        console.log(`ultragoal plan created: ${plan.goals.length} goal(s)`);
        console.log(`brief: ${plan.briefPath}`);
        console.log(`goals: ${plan.goalsPath}`);
        console.log(`ledger: ${plan.ledgerPath}`);
      }
      return;
    }

    if (command === 'status') {
      const plan = await readUltragoalPlan(cwd);
      const snapshot = await readClaudeGoalSnapshotInput(readValue(rest, '--claude-goal-json'), cwd);
      const activeGoal = plan.goals.find((goal) => goal.id === plan.activeGoalId || goal.status === 'in_progress');
      const expectedObjective = plan.claudeGoalMode === 'aggregate'
        ? plan.claudeObjective
        : activeGoal?.objective;
      const reconciliation = activeGoal
        ? reconcileClaudeGoalSnapshot(snapshot, {
          expectedObjective: expectedObjective ?? activeGoal.objective,
          allowedStatuses: plan.claudeGoalMode === 'aggregate' ? ['active'] : ['active', 'complete'],
          requireSnapshot: false,
        })
        : null;
      if (json) printJson({ plan, summary: summarizeUltragoalPlan(plan), reconciliation });
      else {
        printStatus(plan);
        if (reconciliation && !reconciliation.ok) console.log(`claude goal warning: ${formatClaudeGoalReconciliation(reconciliation)}`);
        else if (reconciliation?.warnings.length) console.log(`claude goal warning: ${formatClaudeGoalReconciliation(reconciliation)}`);
      }
      return;
    }

    if (command === 'add-goal') {
      const title = readValue(rest, '--title');
      const objective = readValue(rest, '--objective');
      if (!title?.trim()) throw new UltragoalError('Missing --title.');
      if (!objective?.trim()) throw new UltragoalError('Missing --objective.');
      const result = await addUltragoalGoal(cwd, { title, objective, evidence: readValue(rest, '--evidence') });
      if (json) printJson({ ok: true, plan: result.plan, addedGoal: result.goal, summary: summarizeUltragoalPlan(result.plan) });
      else {
        console.log(`ultragoal added goal: ${result.goal.id}`);
        printStatus(result.plan);
      }
      return;
    }

    if (command === 'record-review-blockers') {
      const goalId = readValue(rest, '--goal-id');
      const title = readValue(rest, '--title');
      const objective = readValue(rest, '--objective');
      const evidence = readValue(rest, '--evidence');
      if (!goalId) throw new UltragoalError('Missing --goal-id.');
      if (!title?.trim()) throw new UltragoalError('Missing --title.');
      if (!objective?.trim()) throw new UltragoalError('Missing --objective.');
      if (!evidence?.trim()) throw new UltragoalError('Missing --evidence.');
      const claudeGoal = await parseClaudeGoalJson(readValue(rest, '--claude-goal-json'));
      const result = await recordFinalReviewBlockers(cwd, { goalId, title, objective, evidence, claudeGoal });
      if (json) printJson({ ok: true, plan: result.plan, blockedGoal: result.blockedGoal, addedGoal: result.addedGoal, summary: summarizeUltragoalPlan(result.plan) });
      else {
        console.log(`ultragoal final review blockers recorded: ${result.blockedGoal.id} -> review_blocked; added ${result.addedGoal.id}`);
        printStatus(result.plan);
      }
      return;
    }

    if (command === 'complete' || command === 'complete-goals' || command === 'next' || command === 'start-next') {
      const result = await startNextUltragoal(cwd, { retryFailed: hasFlag(rest, '--retry-failed') });
      if (!result.goal) {
        if (json) printJson({ ok: true, done: result.done, summary: summarizeUltragoalPlan(result.plan) });
        else console.log(result.done ? 'ultragoal: all goals complete' : 'ultragoal: no pending goals (use --retry-failed to retry failed goals)');
        return;
      }
      const instruction = buildClaudeGoalInstruction(result.goal, result.plan);
      if (json) printJson({ ok: true, resumed: result.resumed, goal: result.goal, instruction });
      else console.log(instruction);
      return;
    }

    if (command === 'checkpoint') {
      const goalId = readValue(rest, '--goal-id');
      const status = readValue(rest, '--status');
      if (!goalId) throw new UltragoalError('Missing --goal-id.');
      if (status !== 'complete' && status !== 'failed' && status !== 'blocked') throw new UltragoalError('Missing or invalid --status; expected complete, failed, or blocked.');
      const evidence = readValue(rest, '--evidence');
      const claudeGoal = await parseClaudeGoalJson(readValue(rest, '--claude-goal-json'));
      const qualityGate = await readJsonInput(readValue(rest, '--quality-gate-json'));
      const plan = await checkpointUltragoal(cwd, { goalId, status, evidence, claudeGoal, qualityGate });
      if (json) printJson({ ok: true, plan, summary: summarizeUltragoalPlan(plan) });
      else {
        const goal = plan.goals.find((candidate: UltragoalItem) => candidate.id === goalId);
        console.log(`ultragoal checkpoint: ${goalId} -> ${goal?.status ?? status}`);
        printStatus(plan);
      }
      return;
    }

    throw new UltragoalError(`Unknown ultragoal command: ${command}\n\n${ULTRAGOAL_HELP}`);
  } catch (error) {
    if (error instanceof UltragoalError || error instanceof ClaudeGoalSnapshotError) {
      console.error(`[ultragoal] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
