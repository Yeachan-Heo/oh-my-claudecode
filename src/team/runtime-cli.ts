/**
 * CLI entry point for team runtime.
 * Reads JSON config from stdin, runs startTeam/monitorTeam/shutdownTeam,
 * writes structured JSON result to stdout.
 *
 * Bundled as CJS via esbuild (scripts/build-runtime-cli.mjs).
 */

import { readdirSync, readFileSync } from 'fs';
import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { startTeam, monitorTeam, shutdownTeam } from './runtime.js';
import type { TeamConfig, TeamRuntime } from './runtime.js';
import { waitForSentinelReadiness } from './sentinel-gate.js';
import { isRuntimeV2Enabled, startTeamV2, monitorTeamV2, shutdownTeamV2 } from './runtime-v2.js';
import type { TeamSnapshotV2 } from './runtime-v2.js';

interface CliInput {
  teamName: string;
  workerCount?: number;
  agentTypes: string[];
  tasks: Array<{ subject: string; description: string }>;
  cwd: string;
  newWindow?: boolean;
  pollIntervalMs?: number;
  sentinelGateTimeoutMs?: number;
  sentinelGatePollIntervalMs?: number;
}

interface TaskResult {
  taskId: string;
  status: string;
  summary: string;
}

interface CliOutput {
  status: 'completed' | 'failed';
  teamName: string;
  taskResults: TaskResult[];
  duration: number;
  workerCount: number;
}

interface WatchdogFailedMarker {
  failedAt: string | number;
}

type TerminalStatus = 'completed' | 'failed' | null;

export function getTerminalStatus(
  taskCounts: { pending: number; inProgress: number; completed: number; failed: number },
  expectedTaskCount: number,
): TerminalStatus {
  const active = taskCounts.pending + taskCounts.inProgress;
  const terminal = taskCounts.completed + taskCounts.failed;
  if (active !== 0 || terminal !== expectedTaskCount) return null;
  return taskCounts.failed > 0 ? 'failed' : 'completed';
}

function parseWatchdogFailedAt(marker: WatchdogFailedMarker): number {
  if (typeof marker.failedAt === 'number') return marker.failedAt;
  if (typeof marker.failedAt === 'string') {
    const numeric = Number(marker.failedAt);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(marker.failedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error('watchdog marker missing valid failedAt');
}

export async function checkWatchdogFailedMarker(
  stateRoot: string,
  startTime: number,
): Promise<{ failed: boolean; reason?: string }> {
  const markerPath = join(stateRoot, 'watchdog-failed.json');
  let raw: string;
  try {
    raw = await readFile(markerPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { failed: false };
    return { failed: true, reason: `Failed to read watchdog marker: ${err}` };
  }

  let marker: WatchdogFailedMarker;
  try {
    marker = JSON.parse(raw) as WatchdogFailedMarker;
  } catch (err) {
    return { failed: true, reason: `Failed to parse watchdog marker: ${err}` };
  }

  let failedAt: number;
  try {
    failedAt = parseWatchdogFailedAt(marker);
  } catch (err) {
    return { failed: true, reason: `Invalid watchdog marker: ${err}` };
  }

  if (failedAt >= startTime) {
    return { failed: true, reason: `Watchdog marked team failed at ${new Date(failedAt).toISOString()}` };
  }

  try {
    await unlink(markerPath);
  } catch {
    // best-effort stale marker cleanup
  }

  return { failed: false };
}

export async function writeResultArtifact(
  output: CliOutput,
  finishedAt: string,
  jobId: string | undefined = process.env.OMC_JOB_ID,
  omcJobsDir: string | undefined = process.env.OMC_JOBS_DIR,
): Promise<void> {
  if (!jobId || !omcJobsDir) return;
  const resultPath = join(omcJobsDir, `${jobId}-result.json`);
  const tmpPath = `${resultPath}.tmp`;
  await writeFile(
    tmpPath,
    JSON.stringify({ ...output, finishedAt }),
    'utf-8',
  );
  await rename(tmpPath, resultPath);
}

async function writePanesFile(
  jobId: string | undefined,
  paneIds: string[],
  leaderPaneId: string,
  sessionName: string,
  ownsWindow: boolean,
): Promise<void> {
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;

  const panesPath = join(omcJobsDir, `${jobId}-panes.json`);
  await writeFile(
    panesPath + '.tmp',
    JSON.stringify({ paneIds: [...paneIds], leaderPaneId, sessionName, ownsWindow }),
  );
  await rename(panesPath + '.tmp', panesPath);
}

function collectTaskResults(stateRoot: string): TaskResult[] {
  const tasksDir = join(stateRoot, 'tasks');
  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const raw = readFileSync(join(tasksDir, f), 'utf-8');
        const task = JSON.parse(raw) as { id?: string; status?: string; result?: string; summary?: string };
        return {
          taskId: task.id ?? f.replace('.json', ''),
          status: task.status ?? 'unknown',
          summary: (task.result ?? task.summary) ?? '',
        };
      } catch {
        return { taskId: f.replace('.json', ''), status: 'unknown', summary: '' };
      }
    });
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const startTime = Date.now();

  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const rawInput = Buffer.concat(chunks).toString('utf-8').trim();

  let input: CliInput;
  try {
    input = JSON.parse(rawInput) as CliInput;
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to parse stdin JSON: ${err}\n`);
    process.exit(1);
  }

  // Validate required fields
  const missing: string[] = [];
  if (!input.teamName) missing.push('teamName');
  if (!input.agentTypes || !Array.isArray(input.agentTypes) || input.agentTypes.length === 0) missing.push('agentTypes');
  if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) missing.push('tasks');
  if (!input.cwd) missing.push('cwd');
  if (missing.length > 0) {
    process.stderr.write(`[runtime-cli] Missing required fields: ${missing.join(', ')}\n`);
    process.exit(1);
  }

  const {
    teamName,
    agentTypes,
    tasks,
    cwd,
    newWindow = false,
    pollIntervalMs = 5000,
    sentinelGateTimeoutMs = 30_000,
    sentinelGatePollIntervalMs = 250,
  } = input;

  const workerCount = input.workerCount ?? agentTypes.length;
  const stateRoot = join(cwd, `.omc/state/team/${teamName}`);

  const config: TeamConfig = {
    teamName,
    workerCount,
    agentTypes: agentTypes as TeamConfig['agentTypes'],
    tasks,
    cwd,
    newWindow,
  };

  const useV2 = isRuntimeV2Enabled();
  let runtime: TeamRuntime | null = null;
  let finalStatus: 'completed' | 'failed' = 'failed';
  let pollActive = true;

  function exitCodeFor(status: 'completed' | 'failed'): number {
    return status === 'completed' ? 0 : 1;
  }

  async function doShutdown(status: 'completed' | 'failed'): Promise<void> {
    pollActive = false;
    finalStatus = status;

    // 1. Stop watchdog first (v1 only) — prevents late tick from racing with result collection
    if (!useV2 && runtime?.stopWatchdog) {
      runtime.stopWatchdog();
    }

    // 2. Collect task results (watchdog is now stopped, no more writes to tasks/)
    const taskResults = collectTaskResults(stateRoot);

    // 3. Shutdown team
    if (runtime) {
      try {
        if (useV2) {
          await shutdownTeamV2(runtime.teamName, runtime.cwd, { force: true });
        } else {
          await shutdownTeam(
            runtime.teamName,
            runtime.sessionName,
            runtime.cwd,
            2_000,
            runtime.workerPaneIds,
            runtime.leaderPaneId,
            runtime.ownsWindow,
          );
        }
      } catch (err) {
        process.stderr.write(`[runtime-cli] shutdown error: ${err}\n`);
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    const output: CliOutput = {
      status: finalStatus,
      teamName,
      taskResults,
      duration,
      workerCount,
    };
    const finishedAt = new Date().toISOString();

    try {
      await writeResultArtifact(output, finishedAt);
    } catch (err) {
      process.stderr.write(`[runtime-cli] Failed to persist result artifact: ${err}\n`);
    }

    // 4. Write result to stdout
    process.stdout.write(JSON.stringify(output) + '\n');

    // 5. Exit
    process.exit(exitCodeFor(status));
  }

  // Register signal handlers before poll loop
  process.on('SIGINT', () => {
    process.stderr.write('[runtime-cli] Received SIGINT, shutting down...\n');
    doShutdown('failed').catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    process.stderr.write('[runtime-cli] Received SIGTERM, shutting down...\n');
    doShutdown('failed').catch(() => process.exit(1));
  });

  // Start the team — v2 uses direct tmux spawn with CLI API inbox (no done.json, no watchdog)
  try {
    if (useV2) {
      const v2Runtime = await startTeamV2({
        teamName,
        workerCount,
        agentTypes,
        tasks,
        cwd,
        newWindow,
      });
      const v2PaneIds = v2Runtime.config.workers
        .map(w => w.pane_id)
        .filter((p): p is string => typeof p === 'string');
      runtime = {
        teamName: v2Runtime.teamName,
        sessionName: v2Runtime.sessionName,
        leaderPaneId: v2Runtime.config.leader_pane_id || '',
        ownsWindow: v2Runtime.ownsWindow,
        config,
        workerNames: v2Runtime.config.workers.map(w => w.name),
        workerPaneIds: v2PaneIds,
        activeWorkers: new Map(),
        cwd,
      };
    } else {
      runtime = await startTeam(config);
    }
  } catch (err) {
    process.stderr.write(`[runtime-cli] startTeam failed: ${err}\n`);
    process.exit(1);
  }

  // Persist pane IDs so MCP server can clean up explicitly via omc_run_team_cleanup.
  const jobId = process.env.OMC_JOB_ID;
  const expectedTaskCount = tasks.length;
  let mismatchStreak = 0;
  try {
    await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}\n`);
  }

  // ── V2 event-driven poll loop (no watchdog) ────────────────────────────
  if (useV2) {
    process.stderr.write('[runtime-cli] Using runtime v2 (event-driven, no watchdog)\n');

    while (pollActive) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      if (!pollActive) break;

      let snap: TeamSnapshotV2 | null;
      try {
        snap = await monitorTeamV2(teamName, cwd);
      } catch (err) {
        process.stderr.write(`[runtime-cli/v2] monitorTeamV2 error: ${err}\n`);
        continue;
      }

      if (!snap) {
        process.stderr.write('[runtime-cli/v2] monitorTeamV2 returned null (team config missing?)\n');
        await doShutdown('failed');
        return;
      }

      try {
        await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
      } catch { /* best-effort panes file write */ }

      process.stderr.write(
        `[runtime-cli/v2] phase=${snap.phase} pending=${snap.tasks.pending} in_progress=${snap.tasks.in_progress} completed=${snap.tasks.completed} failed=${snap.tasks.failed} dead=${snap.deadWorkers.length} totalMs=${snap.performance.total_ms}\n`,
      );

      // Terminal check via task counts
      const v2Observed = snap.tasks.pending + snap.tasks.in_progress + snap.tasks.completed + snap.tasks.failed;
      if (v2Observed !== expectedTaskCount) {
        mismatchStreak += 1;
        process.stderr.write(
          `[runtime-cli/v2] Task-count mismatch observed=${v2Observed} expected=${expectedTaskCount} streak=${mismatchStreak}\n`,
        );
        if (mismatchStreak >= 2) {
          process.stderr.write('[runtime-cli/v2] Persistent task-count mismatch — failing fast\n');
          await doShutdown('failed');
          return;
        }
        continue;
      }
      mismatchStreak = 0;

      if (snap.allTasksTerminal) {
        const hasFailures = snap.tasks.failed > 0;
        if (!hasFailures) {
          // Sentinel gate before declaring success
          const sentinelLogPath = join(cwd, 'sentinel_stop.jsonl');
          const gateResult = await waitForSentinelReadiness({
            workspace: cwd,
            logPath: sentinelLogPath,
            timeoutMs: sentinelGateTimeoutMs,
            pollIntervalMs: sentinelGatePollIntervalMs,
          });
          if (!gateResult.ready) {
            process.stderr.write(
              `[runtime-cli/v2] Sentinel gate blocked: ${gateResult.blockers.join('; ')}\n`,
            );
            await doShutdown('failed');
            return;
          }
          await doShutdown('completed');
        } else {
          process.stderr.write('[runtime-cli/v2] Terminal failure detected from task counts\n');
          await doShutdown('failed');
        }
        return;
      }

      // Dead worker heuristic
      const allDead = runtime.workerPaneIds.length > 0 && snap.deadWorkers.length === runtime.workerPaneIds.length;
      const hasOutstanding = (snap.tasks.pending + snap.tasks.in_progress) > 0;
      if (allDead && hasOutstanding) {
        process.stderr.write('[runtime-cli/v2] All workers dead with outstanding work — failing\n');
        await doShutdown('failed');
        return;
      }
    }
    return;
  }

  // ── V1 poll loop (legacy watchdog-based) ────────────────────────────────
  while (pollActive) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    if (!pollActive) break;

    const watchdogCheck = await checkWatchdogFailedMarker(stateRoot, startTime);
    if (watchdogCheck.failed) {
      process.stderr.write(`[runtime-cli] ${watchdogCheck.reason ?? 'Watchdog failure marker detected'}\n`);
      await doShutdown('failed');
      return;
    }

    let snap;
    try {
      snap = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
    } catch (err) {
      process.stderr.write(`[runtime-cli] monitorTeam error: ${err}\n`);
      continue;
    }

    try {
      await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
    } catch (err) {
      process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}\n`);
    }

    process.stderr.write(
      `[runtime-cli] phase=${snap.phase} pending=${snap.taskCounts.pending} inProgress=${snap.taskCounts.inProgress} completed=${snap.taskCounts.completed} failed=${snap.taskCounts.failed} dead=${snap.deadWorkers.length} monitorMs=${snap.monitorPerformance.totalMs} tasksMs=${snap.monitorPerformance.listTasksMs} workerMs=${snap.monitorPerformance.workerScanMs}\n`,
    );

    const observedTaskCount = snap.taskCounts.pending
      + snap.taskCounts.inProgress
      + snap.taskCounts.completed
      + snap.taskCounts.failed;
    if (observedTaskCount !== expectedTaskCount) {
      mismatchStreak += 1;
      process.stderr.write(
        `[runtime-cli] Task-count mismatch observed=${observedTaskCount} expected=${expectedTaskCount} streak=${mismatchStreak}\n`,
      );
      if (mismatchStreak >= 2) {
        process.stderr.write('[runtime-cli] Persistent task-count mismatch detected — failing fast\n');
        await doShutdown('failed');
        return;
      }
      continue;
    }
    mismatchStreak = 0;

    const terminalStatus = getTerminalStatus(snap.taskCounts, expectedTaskCount);

    // Check completion — enforce sentinel readiness gate before terminal success
    if (terminalStatus === 'completed') {
      const sentinelLogPath = join(cwd, 'sentinel_stop.jsonl');
      const gateResult = await waitForSentinelReadiness({
        workspace: cwd,
        logPath: sentinelLogPath,
        timeoutMs: sentinelGateTimeoutMs,
        pollIntervalMs: sentinelGatePollIntervalMs,
      });

      if (!gateResult.ready) {
        process.stderr.write(
          `[runtime-cli] Sentinel gate blocked completion (timedOut=${gateResult.timedOut}, attempts=${gateResult.attempts}, elapsedMs=${gateResult.elapsedMs}): ${gateResult.blockers.join('; ')}\n`,
        );
        await doShutdown('failed');
        return;
      }

      await doShutdown('completed');
      return;
    }

    if (terminalStatus === 'failed') {
      process.stderr.write('[runtime-cli] Terminal failure detected from task counts\n');
      await doShutdown('failed');
      return;
    }

    // Check failure heuristics
    const allWorkersDead = runtime.workerPaneIds.length > 0 && snap.deadWorkers.length === runtime.workerPaneIds.length;
    const hasOutstandingWork = (snap.taskCounts.pending + snap.taskCounts.inProgress) > 0;

    const deadWorkerFailure = allWorkersDead && hasOutstandingWork;
    const fixingWithNoWorkers = snap.phase === 'fixing' && allWorkersDead;

    if (deadWorkerFailure || fixingWithNoWorkers) {
      process.stderr.write(`[runtime-cli] Failure detected: deadWorkerFailure=${deadWorkerFailure} fixingWithNoWorkers=${fixingWithNoWorkers}\n`);
      await doShutdown('failed');
      return;
    }
  }

}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`[runtime-cli] Fatal error: ${err}\n`);
    process.exit(1);
  });
}
