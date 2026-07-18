import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import type { OpenClawRoutingSnapshot, SessionEndActionName, SessionEndActionState, SessionEndJobV1 } from './cleanup-manifest.js';
import { getProcessStartIdentity, killProcessTree } from '../../platform/process-utils.js';
import { markSessionEndActionRunner, readSessionEndJob } from './cleanup-manifest.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';

const RUNNER_ARG = '--omc-session-end-action-runner';
export interface ActionRunContext { directory: string; sessionId: string; job: SessionEndJobV1; actionName: SessionEndActionName; action: SessionEndActionState; ownerNonce: string; runnerNonce: string; deadlineAt: number; }
export interface ActionRunResult { code: string; completed: boolean; }
function runDirectory(context: ActionRunContext): string { return path.join(getOmcRoot(context.directory), 'state', 'session-end-jobs', 'runs', context.job.jobId, context.actionName, String(context.action.attempts), context.runnerNonce); }
function openClawRoutingEnvironment(payload: Record<string, unknown>): NodeJS.ProcessEnv {
  const routing = payload.openClawRouting;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return {};
  const snapshot = routing as OpenClawRoutingSnapshot;
  const values: Array<[keyof OpenClawRoutingSnapshot, string]> = [
    ['openClawConfig', 'OMC_OPENCLAW_CONFIG'],
    ['replyChannel', 'OPENCLAW_REPLY_CHANNEL'],
    ['replyTarget', 'OPENCLAW_REPLY_TARGET'],
    ['replyThread', 'OPENCLAW_REPLY_THREAD'],
    ['tmux', 'TMUX'],
    ['tmuxPane', 'TMUX_PANE'],
  ];
  return Object.fromEntries(values.flatMap(([property, environment]) => typeof snapshot[property] === 'string' ? [[environment, snapshot[property]]] : []));
}

function runnerEnvironment(context: ActionRunContext): NodeJS.ProcessEnv {
  const baseKeys = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'LANG', 'LC_ALL', 'NODE_ENV', 'CLAUDE_CONFIG_DIR', 'OMC_STATE_DIR', 'OMC_HOOK_CONFIG', 'OMC_CONFIG_PATH', 'OMC_NOTIFY', 'OMC_NOTIFY_PROFILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];
  const notificationKeys = ['OMC_TELEGRAM', 'OMC_DISCORD', 'OMC_SLACK', 'OMC_WEBHOOK', 'OMC_DISCORD_MENTION', 'OMC_DISCORD_NOTIFIER_BOT_TOKEN', 'OMC_DISCORD_NOTIFIER_CHANNEL', 'OMC_DISCORD_WEBHOOK_URL', 'OMC_TELEGRAM_BOT_TOKEN', 'OMC_TELEGRAM_NOTIFIER_BOT_TOKEN', 'OMC_TELEGRAM_CHAT_ID', 'OMC_TELEGRAM_NOTIFIER_CHAT_ID', 'OMC_TELEGRAM_NOTIFIER_UID', 'OMC_SLACK_WEBHOOK_URL', 'OMC_SLACK_MENTION', 'OMC_SLACK_BOT_TOKEN', 'OMC_SLACK_APP_TOKEN', 'OMC_SLACK_BOT_CHANNEL'];
  const keys = context.actionName === 'callback' || context.actionName === 'notification' ? [...baseKeys, ...notificationKeys] : baseKeys;
  const exact = Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  if (context.actionName !== 'openclaw') return exact;
  const enabled = context.action.payload.openClawEnabled === true ? { OMC_OPENCLAW: '1' } : {};
  return { ...exact, ...enabled, ...openClawRoutingEnvironment(context.action.payload) };
}

const POST_KILL_SETTLE_MS = 250;


/** Each deferred action runs in its own detached process group. The manifest remains the only authority for claim/result transitions. */
export async function runSessionEndAction(context: ActionRunContext, _execute: () => Promise<void>): Promise<ActionRunResult> {
  const runPath = runDirectory(context);
  try {
    fs.mkdirSync(runPath, { recursive: true });
    if (Date.now() >= context.deadlineAt) return { code: 'deadline-before-arm', completed: false };
    const childInput = { directory: context.directory, sessionId: context.sessionId, jobId: context.job.jobId, actionName: context.actionName, attempt: context.action.attempts, ownerNonce: context.ownerNonce, runnerNonce: context.runnerNonce, runPath, deadlineAt: context.deadlineAt };
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), RUNNER_ARG, JSON.stringify(childInput)], { detached: true, stdio: 'ignore', windowsHide: true, env: runnerEnvironment(context) });
    child.unref();
    let settled = false;
    let exitCode: number | null = null;
    let settleChild: (code: number | null) => void = () => undefined;
    const childExit = new Promise<number | null>((resolve) => {
      settleChild = (code) => {
        if (settled) return;
        settled = true;
        exitCode = code;
        resolve(code);
      };
      child.once('exit', settleChild);
      child.once('error', () => settleChild(null));
    });
    let deadlineTermination: Promise<void> | undefined;
    let resolveTermination!: () => void;
    const terminationFinished = new Promise<void>((resolve) => { resolveTermination = resolve; });
    const terminate = async (): Promise<void> => {
      const postKillWait = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, context.deadlineAt + POST_KILL_SETTLE_MS - Date.now()));
        timer.unref();
      });
      await Promise.race([Promise.resolve(killProcessTree(child.pid!, 'SIGKILL')).catch(() => false), postKillWait]);
      await Promise.race([childExit, postKillWait]);
    };
    const timeout = setTimeout(() => {
      deadlineTermination ??= terminate().finally(resolveTermination);
    }, Math.max(1, context.deadlineAt - Date.now()));
    const identity = await getProcessStartIdentity(child.pid!, context.deadlineAt);
    if (!identity) { clearTimeout(timeout); await terminate(); return { code: 'runner-identity-unavailable', completed: false }; }
    if (settled) { clearTimeout(timeout); return { code: exitCode === null ? 'runner-deadline' : `runner-exit-${exitCode}`, completed: false }; }
    atomicWriteJsonSync(path.join(runPath, 'control.json'), { jobId: context.job.jobId, action: context.actionName, attempt: context.action.attempts, runnerNonce: context.runnerNonce, ownerNonce: context.ownerNonce, runner: { pid: child.pid, processStartIdentity: identity }, deadlineAt: new Date(context.deadlineAt).toISOString(), idempotencyKey: context.action.idempotencyKey });
    atomicWriteJsonSync(path.join(runPath, 'arm.json'), { runnerNonce: context.runnerNonce, ownerNonce: context.ownerNonce, armedAt: new Date().toISOString() });
    if (!markSessionEndActionRunner(context.directory, context.sessionId, context.ownerNonce, context.actionName, context.runnerNonce, 'armed')) { clearTimeout(timeout); await terminate(); return { code: 'runner-claim-lost', completed: false }; }
    const terminal = await Promise.race([
      childExit.then(code => ({ code, terminated: false })),
      terminationFinished.then(() => ({ code: null, terminated: true })),
    ]);
    clearTimeout(timeout);
    await deadlineTermination;
    const completed = terminal.code === 0 && !terminal.terminated && !deadlineTermination;
    const code = completed ? 'completed' : deadlineTermination || terminal.terminated || terminal.code === null ? 'runner-deadline' : `runner-exit-${terminal.code}`;
    atomicWriteJsonSync(path.join(runPath, 'result.json'), { code, completedAt: new Date().toISOString() });
    return { code, completed };
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
