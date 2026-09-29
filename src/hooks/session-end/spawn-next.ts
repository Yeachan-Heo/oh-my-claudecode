import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn, type SpawnOptions } from 'child_process';
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
  /** Per-stage link counts carried forward so the enqueuer can cap route loops. */
  visits?: Record<string, number>;
}

export interface SpawnNextPlan {
  directive: { stage: string; skill: string };
  handoffPath: string;
  spawnArgv: string[];
  /** Pre-generated id of the next link, passed via --session-id so its SessionEnd finds the ledger. */
  nextSessionId: string;
  trackerCommands: string[][];
}

export type SpawnFn = (command: string, args: string[], ctx?: SpawnContext) => { unref(): void };

/** Factory links spawn headless (AFK): their cwd must match the ledger's state root and their permission profile must be narrow. */
export interface SpawnContext {
  cwd?: string;
}

/**
 * AFK allowlist for factory-spawned sessions: gh read/comment, file read/write,
 * and github.com-only WebFetch. Everything else is denied in -p mode and must
 * fall back to HITL (the session's issue-comment contract), never silent failure.
 */
export const AFK_ALLOWED_TOOLS = [
  'Bash(gh issue view:*)',
  'Bash(gh issue comment:*)',
  'Bash(gh issue edit:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(gh label list:*)',
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'WebFetch(domain:github.com)',
].join(',');

export const AFK_SPAWN_FLAGS = [
  '--permission-mode', 'acceptEdits',
  '--allowedTools', AFK_ALLOWED_TOOLS,
  // Isolation: AFK links run with project+local settings only — user-level
  // hooks/settings must never fire in a headless chain link.
  '--setting-sources', 'project,local',
];

/** Args (command excluded) for one factory chain link: intent prompt + AFK permission profile. */
export function factoryLinkArgv(prompt: string, sessionId: string): string[] {
  return ['-p', prompt, '--session-id', sessionId, ...AFK_SPAWN_FLAGS];
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
/** Shared label charset (stage/skill/labels): safe for paths and argv. */
export const LABEL_PATTERN = /^[\w.-]+$/;

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
  if (chain.visits) {
    for (const [stage, count] of Object.entries(chain.visits)) {
      if (!LABEL_PATTERN.test(stage) || !Number.isInteger(count) || count < 0 || count > 99) {
        throw new Error(`invalid visits entry: ${stage}=${count}`);
      }
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
    spawnArgv: ['claude', ...factoryLinkArgv(`/${directive.skill} 继续 ${directive.stage} 环；交接上下文：${path.basename(handoffPath)}`, nextSessionId)],
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
  const factoryDir = path.join(omcRoot, 'state', 'factory');
  const ledgerPath = path.join(factoryDir, `chain-${plan.nextSessionId}.json`);
  try {
    // The next link's ledger must exist before it ends its session, so the
    // SessionEnd enqueuer finds it; written under the same failure alerts.
    fs.mkdirSync(factoryDir, { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({
      intentId: chain.intentId ?? `chain-${chain.sessionId}`,
      stage: plan.directive.stage,
      routeTable: chain.routeTable,
      tracker: chain.tracker,
      visits: { ...(chain.visits ?? {}), [plan.directive.stage]: (chain.visits?.[plan.directive.stage] ?? 0) + 1 },
    }, null, 2), 'utf8');
    spawnFn(plan.spawnArgv[0], plan.spawnArgv.slice(1), { cwd: directory });
  } catch (error) {
    // Don't leave a dead ledger pointing at a session that never started.
    try { fs.unlinkSync(ledgerPath); } catch { /* never written */ }
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
 * The -p prompt goes through stdin on Windows: cmd.exe's ANSI codepage
 * mangles non-ASCII argv (dogfood: Chinese intent prompts mojibake'd),
 * while the stdin pipe stays UTF-8 end to end.
 *
 * detached:true is win32-hostile here (dogfood bisect: cmd.exe children
 * spawned detached exit 1 before writing a transcript), so it is only
 * applied off-win32. Orphaning still holds: Windows children survive
 * parent exit without the detached flag.
 */
export function defaultSpawnFn(command: string, args: string[], ctx?: SpawnContext): { unref(): void } {
  const baseOpts: SpawnOptions =
    process.platform === 'win32'
      ? { windowsHide: true, cwd: ctx?.cwd }
      : { detached: true, windowsHide: true, cwd: ctx?.cwd };
  if (process.platform === 'win32' && command === 'claude') {
    const pIdx = args.indexOf('-p');
    const inlinePrompt = pIdx !== -1 && pIdx + 1 < args.length ? args[pIdx + 1] : undefined;
    if (inlinePrompt !== undefined && !inlinePrompt.startsWith('--')) {
      const rest = [...args.slice(0, pIdx + 1), ...args.slice(pIdx + 2)];
      const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command} ${rest.map(quoteForCmd).join(' ')}"`], {
        ...baseOpts,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsVerbatimArguments: true,
      });
      child.stdin?.write(inlinePrompt, 'utf8');
      child.stdin?.end();
      child.unref();
      return child;
    }
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command} ${args.map(quoteForCmd).join(' ')}"`], {
      ...baseOpts,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
    return child;
  }
  const child = spawn(command, args, { ...baseOpts, stdio: 'ignore' });
  child.unref();
  return child;
}
