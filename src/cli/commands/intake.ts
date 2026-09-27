/**
 * Intake Command (P2 Part B, contract: docs/design/P2-RUN-LEDGER-AND-INTAKE-PLAN.md)
 *
 * Gives the harbor headless sweep its power switch:
 *   omc intake run --headless       one sweep: preconditions -> headless session -> exit
 *   omc intake schedule --cron ...  register the sweep with the HOST scheduler
 *   omc intake schedule --off       remove it
 *
 * Doctrine (inherited from harbor and the #4113 review):
 * - The timer belongs to the host scheduler; OMC runs no daemon.
 * - The CLI executes preconditions and facts only; every disposition stays
 *   inside the harbor skill (labels it may create; nothing else).
 * - No PR, no push, no tracker posting happens from this file.
 */

import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';

const HARBOR_LABELS = [
  'harbor:accepted',
  'harbor:need-decision',
  'harbor:need-info',
  'harbor:rejected',
  'harbor:for-maintainer',
  'harbor:needs-exploration',
  'harbor:merge-ready',
  'harbor:changes-requested',
];

const HARBOR_SWEEP_PROMPT = '/oh-my-claudecode:harbor sweep';
const TASK_NAME = 'OMC Intake';
const CRONTAB_MARKER = '# omc-intake';
const LOCK_STALE_MS = 2 * 3600_000;

export interface IntakeExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type IntakeRunner = (cmd: string, args: string[], options: { cwd: string; env?: Record<string, string>; input?: string }) => IntakeExecResult;

/** Real runner: git-style spawn with a bounded timeout and captured output. */
export const defaultIntakeRunner: IntakeRunner = (cmd, args, options) => {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 60_000,
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  return { status: result.status ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export interface PreconditionCheck {
  ok: boolean;
  reason?: string;
}

/** Tracker reachable: `gh repo view` answers in the working directory. */
export function checkTrackerReachable(cwd: string, runner: IntakeRunner): PreconditionCheck {
  const result = runner('gh', ['repo', 'view'], { cwd });
  if (result.status !== 0) {
    return { ok: false, reason: `tracker unreachable (gh repo view failed):\n${result.stderr.trim().slice(0, 400)}` };
  }
  return { ok: true };
}

/** Harbor labels exist or can be created (harbor's own first-use contract). */
export function checkOrCreateHarborLabels(cwd: string, runner: IntakeRunner): PreconditionCheck {
  const list = runner('gh', ['label', 'list', '--json', 'name'], { cwd });
  if (list.status !== 0) {
    return { ok: false, reason: `cannot list labels:\n${list.stderr.trim().slice(0, 400)}` };
  }
  let existing: string[] = [];
  try {
    existing = (JSON.parse(list.stdout) as Array<{ name: string }>).map((l) => l.name);
  } catch {
    return { ok: false, reason: 'cannot parse gh label list output' };
  }
  const missing = HARBOR_LABELS.filter((label) => !existing.includes(label));
  for (const label of missing) {
    const create = runner('gh', ['label', 'create', label, '--color', '7c7c7c'], { cwd });
    if (create.status !== 0) {
      return { ok: false, reason: `cannot create missing label ${label}:\n${create.stderr.trim().slice(0, 300)}` };
    }
  }
  return { ok: true };
}

/**
 * Single-writer lock: one intake run per repository. The lock is stale after
 * LOCK_STALE_MS regardless of pid liveness (crashed runners must not wedge
 * the intake forever).
 */
export function acquireIntakeLock(cwd: string, now = Date.now()): PreconditionCheck {
  const lockPath = join(getOmcRoot(cwd), 'state', 'intake-lock.json');
  try {
    if (existsSync(lockPath)) {
      let started = 0;
      try {
        started = Date.parse((JSON.parse(readFileSync(lockPath, 'utf8')) as { startedAt?: string }).startedAt ?? '') || 0;
      } catch {
        started = 0;
      }
      if (now - started < LOCK_STALE_MS) {
        return { ok: false, reason: `another intake run appears active (lock at ${lockPath}, started ${new Date(started).toISOString()}). Remove the lock only if you are certain no sweep is running.` };
      }
    }
    mkdirFor(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }, null, 2));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `cannot write intake lock: ${(error as Error).message}` };
  }
}

export function releaseIntakeLock(cwd: string): void {
  try {
    const lockPath = join(getOmcRoot(cwd), 'state', 'intake-lock.json');
    if (existsSync(lockPath)) writeFileSync(lockPath, '', 'utf8');
  } catch {
    // best-effort release
  }
}

function mkdirFor(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
}

/**
 * Classify a cron expression into the subset the Windows Task Scheduler can
 * express. Everything outside this subset is refused on Windows (with the
 * crontab option noted), never silently approximated.
 */
export function parseSimpleCron(expr: string): { kind: 'minutes'; every: number } | { kind: 'daily'; hour: number; minute: number } | { kind: 'unsupported' } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { kind: 'unsupported' };
  const [minute, hour, dom, month, dow] = fields;
  if (dom !== '*' || month !== '*' || dow !== '*') return { kind: 'unsupported' };

  const stepMinutes = /^\*\/(\d+)$/.exec(minute);
  if (stepMinutes && hour === '*' && Number(stepMinutes[1]) > 0 && 60 % Number(stepMinutes[1]) === 0) {
    return { kind: 'minutes', every: Number(stepMinutes[1]) };
  }
  const dailyMinute = /^(\d+)$/.exec(minute);
  const dailyHour = /^(\d+)$/.exec(hour);
  if (dailyMinute && dailyHour) {
    const h = Number(dailyHour[1]);
    const m = Number(dailyMinute[1]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return { kind: 'daily', hour: h, minute: m };
  }
  return { kind: 'unsupported' };
}

export interface SchedulePlan {
  platform: 'cron' | 'schtasks';
  crontabLine?: string;
  schtaskArgs?: string[];
}

/** Build the host-native registration plan from the parsed cron expression. */
export function buildSchedulePlan(platform: 'linux' | 'darwin' | 'win32', expr: string, runCommand: string): SchedulePlan | { refused: string } {
  if (platform !== 'win32') {
    return { platform: 'cron', crontabLine: `${expr} ${runCommand} ${CRONTAB_MARKER}` };
  }
  const parsed = parseSimpleCron(expr);
  if (parsed.kind === 'unsupported') {
    return { refused: `unsupported cron expression for Windows Task Scheduler: "${expr}". Supported forms: "*/N * * * *" (every N minutes, N divides 60) and "M H * * *" (daily at H:M). For anything richer, run the schedule on a unix host or register the schtasks entry yourself.` };
  }
  if (parsed.kind === 'minutes') {
    return { platform: 'schtasks', schtaskArgs: ['/Create', '/TN', TASK_NAME, '/SC', 'MINUTE', '/MO', String(parsed.every), '/TR', runCommand, '/F'] };
  }
  const hh = String(parsed.hour).padStart(2, '0');
  const mm = String(parsed.minute).padStart(2, '0');
  return { platform: 'schtasks', schtaskArgs: ['/Create', '/TN', TASK_NAME, '/SC', 'DAILY', '/ST', `${hh}:${mm}`, '/TR', runCommand, '/F'] };
}

/** Keep (remove=false) or drop (remove=true) the marked crontab lines. When
 * installing (remove=false), `installLine` is appended after the cleanup. */
export function filterCrontabLines(existing: string, remove: boolean, installLine?: string): string {
  const kept = existing
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.includes(CRONTAB_MARKER));
  if (!remove && installLine) kept.push(installLine);
  return kept.join('\n');
}

export function buildScheduledCommand(cwd: string): string {
  return `omc intake run --headless --allow-docket-only --cwd "${resolve(cwd)}"`;
}

export interface HeadlessRunResult {
  exitCode: number;
  message: string;
}

/** `omc intake run --headless`: preconditions, lock, headless sweep, exit. */
export function runHeadlessIntake(options: { cwd?: string; claudeBin?: string; allowDocketOnly?: boolean }, runner: IntakeRunner = defaultIntakeRunner): HeadlessRunResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const tracker = checkTrackerReachable(cwd, runner);
  if (!tracker.ok) return { exitCode: 1, message: `intake refused: ${tracker.reason}` };

  const labels = checkOrCreateHarborLabels(cwd, runner);
  if (!labels.ok) return { exitCode: 1, message: `intake refused: ${labels.reason}` };

  const lock = acquireIntakeLock(cwd);
  if (!lock.ok) return { exitCode: 1, message: `intake refused: ${lock.reason}` };

  try {
    if (!options.allowDocketOnly) {
      return { exitCode: 1, message: 'intake refused: no notification channel was verified. Pass --allow-docket-only to run with the docket as the only signal (you read it later), or configure notifications first.' };
    }
    const claudeBin = options.claudeBin ?? 'claude';
    const guardrailsEnv = { OMC_GIT_GUARDRAILS: '1' };
    const child = runner(claudeBin, ['--print', HARBOR_SWEEP_PROMPT], { cwd, env: guardrailsEnv });
    const ok = child.status === 0;
    return {
      exitCode: ok ? 0 : (child.status ?? 1),
      message: ok
        ? 'headless sweep completed. The docket issue in the tracker holds the current intake state — read it for pending boxes; nothing was merged and no authorization was assumed.'
        : `headless sweep failed (exit ${child.status}):\n${(child.stderr || child.stdout).trim().slice(0, 600)}`,
    };
  } finally {
    releaseIntakeLock(cwd);
  }
}

/** `omc intake schedule`: install or remove the host-native entry. */
export function scheduleIntake(options: { cwd?: string; cron: string; off?: boolean }, runner: IntakeRunner = defaultIntakeRunner): HeadlessRunResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runCommand = buildScheduledCommand(cwd);
  const plan = buildSchedulePlan(process.platform as 'linux' | 'darwin' | 'win32', options.cron, runCommand);
  if ('refused' in plan) return { exitCode: 1, message: `intake schedule refused: ${plan.refused}` };

  if (plan.platform === 'cron') {
    const current = runner('crontab', ['-l'], { cwd });
    const existing = current.status === 0 ? current.stdout : '';
    const updated = filterCrontabLines(existing, options.off === true, plan.crontabLine);
    const write = runner('crontab', ['-'], { cwd, input: `${updated}\n` });
    if (write.status !== 0) {
      return { exitCode: 1, message: `intake schedule failed: crontab update did not take:\n${write.stderr.trim().slice(0, 400)}` };
    }
    return {
      exitCode: 0,
      message: options.off
        ? 'scheduled entry removed from crontab.'
        : `scheduled entry installed in crontab:\n  ${plan.crontabLine}`,
    };
  }

  const deleteFirst = runner('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { cwd });
  void deleteFirst;
  if (options.off === true) {
    return { exitCode: 0, message: 'scheduled entry removed (or was already absent).' };
  }
  const create = runner('schtasks', plan.schtaskArgs ?? [], { cwd });
  if (create.status !== 0) {
    return { exitCode: 1, message: `intake schedule failed: schtasks could not create the entry:\n${create.stderr.trim().slice(0, 400)}` };
  }
  return { exitCode: 0, message: `scheduled entry installed in Windows Task Scheduler (task "${TASK_NAME}").` };
}

export function intakeCommand(): Command {
  const cmd = new Command('intake');
  cmd.description('Harbor intake power: run the headless sweep or install its host-native schedule (P2, docs/design/P2-RUN-LEDGER-AND-INTAKE-PLAN.md)');

  cmd
    .command('run')
    .description('Run one headless harbor sweep: preconditions are validated, dispositions stay in the harbor skill')
    .option('--allow-docket-only', 'confirm the docket is the only signal (no notification channel verified)', false)
    .option('--cwd <dir>', 'repository to sweep (defaults to the working directory)')
    .option('--claude <bin>', 'Claude Code CLI binary to spawn for the headless session', 'claude')
    .action((options: { allowDocketOnly?: boolean; cwd?: string; claude?: string }) => {
      const result = runHeadlessIntake({ cwd: options.cwd, claudeBin: options.claude, allowDocketOnly: options.allowDocketOnly });
      console.log(result.message);
      process.exitCode = result.exitCode;
    });

  cmd
    .command('schedule')
    .description('Register (or with --off remove) the host-native scheduled entry for the headless sweep')
    .requiredOption('--cron <expr>', 'cron expression ("*/30 * * * *", "0 6 * * *"); Windows accepts the simple subset')
    .option('--off', 'remove the scheduled entry instead of installing it', false)
    .option('--cwd <dir>', 'repository to sweep (defaults to the working directory)')
    .action((options: { cron: string; off?: boolean; cwd?: string }) => {
      const result = scheduleIntake({ cwd: options.cwd, cron: options.cron, off: options.off });
      console.log(result.message);
      process.exitCode = result.exitCode;
    });

  return cmd;
}
