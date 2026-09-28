import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { decideNextStage, type ChainOutcome, type RouteTable } from './routing.js';
import { getOmcRoot, validateSessionId } from '../../lib/worktree-paths.js';

export interface SpawnNextTracker {
  repo: string;
  issue: number;
  nextLabel: string;
  failedLabel: string;
}

/** How a finished session hands the chain to the next stage. Supplied by the enqueuer in the action payload under `chain`. */
export interface SpawnNextChain {
  outcome: ChainOutcome;
  reason: string;
  routeTable: RouteTable;
  sessionId: string;
  /** Ledger identity carried through so the next link's ledger keeps it. */
  intentId?: string;
  handoffContext?: string;
  tracker?: SpawnNextTracker;
}

export interface SpawnNextPlan {
  directive: { stage: string; skill: string };
  handoffPath: string;
  spawnArgv: string[];
  /** Pre-generated id of the next link, passed via --session-id so its SessionEnd finds the ledger. */
  nextSessionId: string;
  trackerCommands: string[][];
}

export type SpawnFn = (command: string, args: string[]) => { unref(): void };

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const LABEL_PATTERN = /^[\w.-]+$/;

/**
 * The chain rides a detached manifest job: every field that lands in a
 * spawned argv or a filesystem path is validated here. An invalid chain is a
 * hard reject (manifest failure), not a partial spawn.
 */
export function validateChainFields(chain: SpawnNextChain): void {
  validateSessionId(chain.sessionId);
  const tracker = chain.tracker;
  if (tracker) {
    if (!REPO_PATTERN.test(tracker.repo)) throw new Error(`invalid tracker repo: ${tracker.repo}`);
    if (!LABEL_PATTERN.test(tracker.nextLabel) || !LABEL_PATTERN.test(tracker.failedLabel)) {
      throw new Error(`invalid tracker label: ${tracker.nextLabel}/${tracker.failedLabel}`);
    }
  }
}

export function spawnNextAlertComment(chain: SpawnNextChain): string {
  return `链已停住：会话结束状态 ${chain.outcome}:${chain.reason} 触发下一环启动失败，需人工修复（v1 无自动重试）。`;
}

export function planSpawnNext(chain: SpawnNextChain, omcRoot: string): SpawnNextPlan | null {
  validateChainFields(chain);
  const directive = decideNextStage(chain.outcome, chain.reason, chain.routeTable);
  if (!directive) return null;
  const handoffPath = path.join(omcRoot, 'handoffs', `${chain.sessionId}-${directive.stage}.json`);
  const trackerCommands = chain.tracker
    ? [
        ['gh', 'issue', 'edit', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--add-label', chain.tracker.nextLabel],
        ['gh', 'issue', 'comment', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--body', `链已推进到 ${directive.stage}，交接上下文：${path.basename(handoffPath)}`],
      ]
    : [];
  const nextSessionId = randomUUID();
  return {
    directive,
    handoffPath,
    spawnArgv: ['claude', '-p', `/${directive.skill} 继续 ${directive.stage} 环；交接上下文：${path.basename(handoffPath)}`, '--session-id', nextSessionId],
    nextSessionId,
    trackerCommands,
  };
}

/** IO orchestration only: the routing decision comes from the T1 pure function via planSpawnNext. */
export function executeSpawnNext(chain: SpawnNextChain, directory: string, spawnFn: SpawnFn = defaultSpawnFn): void {
  const omcRoot = getOmcRoot(directory);
  const plan = planSpawnNext(chain, omcRoot);
  if (!plan) return;
  fs.mkdirSync(path.dirname(plan.handoffPath), { recursive: true });
  fs.writeFileSync(plan.handoffPath, JSON.stringify({
    sessionId: chain.sessionId,
    from: { outcome: chain.outcome, reason: chain.reason },
    next: plan.directive,
    context: chain.handoffContext ?? '',
  }, null, 2), 'utf8');
  try {
    // The next link's ledger must exist before it ends its session, so the
    // SessionEnd enqueuer finds it; written under the same failure alerts.
    const factoryDir = path.join(omcRoot, 'state', 'factory');
    fs.mkdirSync(factoryDir, { recursive: true });
    fs.writeFileSync(path.join(factoryDir, `chain-${plan.nextSessionId}.json`), JSON.stringify({
      intentId: chain.intentId ?? `chain-${chain.sessionId}`,
      stage: plan.directive.stage,
      routeTable: chain.routeTable,
      tracker: chain.tracker,
    }, null, 2), 'utf8');
    spawnFn(plan.spawnArgv[0], plan.spawnArgv.slice(1));
  } catch (error) {
    if (chain.tracker) {
      spawnFn('gh', ['issue', 'comment', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--body', spawnNextAlertComment(chain)]);
      spawnFn('gh', ['issue', 'edit', String(chain.tracker.issue), '--repo', chain.tracker.repo, '--add-label', chain.tracker.failedLabel]);
    }
    throw error;
  }
  for (const argv of plan.trackerCommands) {
    spawnFn(argv[0], argv.slice(1));
  }
}

function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * `claude` is a .cmd shim on Windows, which CreateProcess cannot exec
 * directly; route that one case through cmd.exe with quoted args. Safe
 * because every dynamic field in the argv was regex-validated upstream.
 */
export function defaultSpawnFn(command: string, args: string[]): { unref(): void } {
  const child =
    process.platform === 'win32' && command === 'claude'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${command} ${args.map(quoteForCmd).join(' ')}"`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}
