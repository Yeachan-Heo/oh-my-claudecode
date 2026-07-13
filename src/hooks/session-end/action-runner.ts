import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import type { SessionEndActionName, SessionEndActionState, SessionEndJobV1 } from './cleanup-manifest.js';
import { getProcessStartIdentity, killProcessTree } from '../../platform/process-utils.js';
import { markSessionEndActionRunner, readSessionEndJob } from './cleanup-manifest.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';

const RUNNER_ARG = '--omc-session-end-action-runner';
export interface ActionRunContext { directory: string; sessionId: string; job: SessionEndJobV1; actionName: SessionEndActionName; action: SessionEndActionState; ownerNonce: string; runnerNonce: string; deadlineAt: number; }
export interface ActionRunResult { code: string; completed: boolean; }
function runDirectory(context: ActionRunContext): string { return path.join(getOmcRoot(context.directory), 'state', 'session-end-jobs', 'runs', context.job.jobId, context.actionName, String(context.action.attempts), context.runnerNonce); }

/** Each deferred action runs in its own detached process group. The manifest remains the only authority for claim/result transitions. */
export async function runSessionEndAction(context: ActionRunContext, _execute: () => Promise<void>): Promise<ActionRunResult> {
  const runPath = runDirectory(context);
  try {
    fs.mkdirSync(runPath, { recursive: true });
    if (Date.now() >= context.deadlineAt) return { code: 'deadline-before-arm', completed: false };
    const childInput = { directory: context.directory, sessionId: context.sessionId, jobId: context.job.jobId, actionName: context.actionName, attempt: context.action.attempts, ownerNonce: context.ownerNonce, runnerNonce: context.runnerNonce, runPath, deadlineAt: context.deadlineAt };
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), RUNNER_ARG, JSON.stringify(childInput)], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    const identity = await getProcessStartIdentity(child.pid!, context.deadlineAt);
    if (!identity) { await killProcessTree(child.pid!, 'SIGKILL'); return { code: 'runner-identity-unavailable', completed: false }; }
    atomicWriteJsonSync(path.join(runPath, 'control.json'), { jobId: context.job.jobId, action: context.actionName, attempt: context.action.attempts, runnerNonce: context.runnerNonce, ownerNonce: context.ownerNonce, runner: { pid: child.pid, processStartIdentity: identity }, deadlineAt: new Date(context.deadlineAt).toISOString(), idempotencyKey: context.action.idempotencyKey });
    atomicWriteJsonSync(path.join(runPath, 'arm.json'), { runnerNonce: context.runnerNonce, ownerNonce: context.ownerNonce, armedAt: new Date().toISOString() });
    if (!markSessionEndActionRunner(context.directory, context.sessionId, context.ownerNonce, context.actionName, context.runnerNonce, 'armed')) { await killProcessTree(child.pid!, 'SIGKILL'); return { code: 'runner-claim-lost', completed: false }; }
    const code = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => { void killProcessTree(child.pid!, 'SIGKILL'); resolve(null); }, Math.max(1, context.deadlineAt - Date.now()));
      child.once('exit', (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
      child.once('error', () => { clearTimeout(timeout); resolve(null); });
    });
    const completed = code === 0;
    atomicWriteJsonSync(path.join(runPath, 'result.json'), { code: completed ? 'completed' : code === null ? 'runner-deadline' : `runner-exit-${code}`, completedAt: new Date().toISOString() });
    return { code: completed ? 'completed' : code === null ? 'runner-deadline' : `runner-exit-${code}`, completed };
  } catch (error) {
    const code = error instanceof Error ? error.name || 'action-failed' : 'action-failed';
    try { atomicWriteJsonSync(path.join(runPath, 'result.json'), { code, retryable: true, recordedAt: new Date().toISOString() }); } catch { /* manifest retains retry authority */ }
    return { code, completed: false };
  }
}

async function runActionRunnerEntrypoint(): Promise<void> {
  const runnerIndex = process.argv.indexOf(RUNNER_ARG);
  if (runnerIndex < 0) return;
  try {
    const input = JSON.parse(process.argv[runnerIndex + 1] ?? '') as { directory: string; sessionId: string; jobId: string; actionName: SessionEndActionName; attempt: number; ownerNonce: string; runnerNonce: string; runPath: string; deadlineAt: number };
    while (Date.now() < input.deadlineAt) {
      let armed = false;
      try {
        const arm = JSON.parse(fs.readFileSync(path.join(input.runPath, 'arm.json'), 'utf8')) as { runnerNonce?: string; ownerNonce?: string };
        const job = readSessionEndJob(input.directory, input.sessionId);
        const action = job?.actions[input.actionName];
        armed = job?.jobId === input.jobId && job.owner?.nonce === input.ownerNonce && action?.status === 'claimed' && action.attempts === input.attempt && action.claimantNonce === input.ownerNonce && action.runner?.runnerNonce === input.runnerNonce && action.runner.phase === 'armed' && arm.runnerNonce === input.runnerNonce && arm.ownerNonce === input.ownerNonce;
      } catch { /* publication is not complete yet */ }
      if (armed) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (Date.now() >= input.deadlineAt) throw new Error('runner-arm-deadline');
    const deadlineTimer = setTimeout(() => { process.exitCode = 124; process.exit(); }, Math.max(1, input.deadlineAt - Date.now()));
    deadlineTimer.unref();
    const { executeSessionEndAction } = await import('./worker.js');
    await executeSessionEndAction(input.actionName, { directory: input.directory, sessionId: input.sessionId }, input.deadlineAt);
    clearTimeout(deadlineTimer);
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}
void runActionRunnerEntrypoint();
