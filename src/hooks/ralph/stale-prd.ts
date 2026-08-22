/**
 * Ralph PRD Stale-State Detection & Reconciliation (#3669)
 *
 * A Ralph PRD can diverge from reality with no detection: work lands outside the
 * loop (campaign branches + PRs + coordinator merges) while prd.json still
 * records `passes: false`, and abnormal exits (crash, force-kill, cancel before
 * Step 8, session end without `/oh-my-claudecode:cancel`) leave the divergence
 * invisible. Anyone resuming the session then reads an authoritative-looking but
 * false record and either redoes landed work or spends effort disproving it.
 *
 * This module detects that stale state and — only when configured observable
 * evidence exists — reconciles it. It never infers completion by itself.
 *
 * ============================================================================
 * Ralph completion / session-end hook map
 * ============================================================================
 *
 * - Step 5 (mark `passes: true`): the ralph agent edits prd.json directly.
 *   There is no code path that re-derives `passes` from observable state —
 *   that gap is the root cause of #3669.
 * - Step 6 (all stories pass): `src/hooks/persistent-mode/index.ts` evaluates
 *   `getPrdCompletionStatus()`; `allComplete` gates final verification.
 * - Step 7 (reviewer verification): `src/hooks/ralph/verifier.ts`
 *   `startVerification()` + architect/critic approval; approval clears the
 *   verification state.
 * - Step 8 (`/oh-my-claudecode:cancel`): `createRalphLoopHook().cancelLoop()`
 *   clears ralph state (`clearRalphState`) plus linked ultrawork state. Step 8
 *   is the ONLY clean exit; every other end leaves ralph state active and/or
 *   the PRD unfinished.
 * - Session end: `src/hooks/session-end/index.ts` `processSessionEnd()` →
 *   `runForegroundSessionEndCleanup()` → `cleanupModeStates()` removes active
 *   ralph mode state. The session-scoped PRD
 *   (`.omc/state/sessions/{id}/prd.json`) is NOT removed and survives into the
 *   next session — which is how a stale PRD gets resumed as if the work were
 *   outstanding. `processSessionEnd` therefore surfaces the warning *before*
 *   mode-state cleanup.
 *
 * ============================================================================
 * Design contract
 * ============================================================================
 *
 * - Detection NEVER infers completion from PR/merge/branch status alone. Git
 *   state is a *stale signal* (stale pointers) only.
 * - Reconciliation marks a story `passes: true` ONLY when configured observable
 *   evidence (content checks: `fileExists` / `fileContains` / `gitGrep`) all
 *   pass. Stories without configured checks are never auto-marked.
 * - Reconciled stories get `architectVerified: false` and must still pass the
 *   Step 7 reviewer verification before final completion. Reconciliation
 *   repairs Step 5; it never bypasses Steps 6–8.
 * - Every reconciliation decision is appended to an audit log
 *   (`prd-reconciliation.jsonl`) and summarized in the story notes, preserving
 *   the audit trail the PRD exists for.
 * - All checks are bounded: git invocations carry a timeout and run with
 *   `windowsHide` (per repo convention), and file checks are confined to the
 *   repository root.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, mkdirSync, appendFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { readModeState } from '../../lib/mode-state-io.js';
import { ensureSessionStateDir, getOmcRoot, getSessionStateDir } from '../../lib/worktree-paths.js';
import {
  findPrdPath,
  readPrd,
  writePrd,
} from './prd.js';

// ============================================================================
// Constants
// ============================================================================

/** Audit log file name, stored next to the PRD in the session state dir. */
export const PRD_RECONCILIATION_AUDIT_FILENAME = 'prd-reconciliation.jsonl';

/** Default age after which an unfinished PRD counts as stale (2h, matching the repo stale-state convention). */
export const DEFAULT_STALE_PRD_AFTER_MS = 2 * 60 * 60 * 1000;

/** Bound for each observable check (git/file). */
const CHECK_TIMEOUT_MS = 5_000;

const GIT_MAX_BUFFER = 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

/**
 * A single observable-evidence check. Checks are content-based on purpose:
 * branch/PR merge status is a detection signal only, never completion evidence.
 */
export interface ObservableCheck {
  /** Check kind. `fileExists`/`fileContains` inspect the working tree; `gitGrep` inspects content at a ref. */
  type: 'fileExists' | 'fileContains' | 'gitGrep';
  /** Repository-relative path for `fileExists` / `fileContains`. */
  path?: string;
  /** Git ref for `gitGrep` (default: `HEAD`). */
  ref?: string;
  /** Substring pattern for `fileContains` / `gitGrep`. */
  pattern?: string;
  /** Optional human-readable description of the evidence being checked. */
  description?: string;
}

/**
 * Per-PRD reconciliation configuration. Lives under `prd.reconciliation` so it
 * travels with the PRD and stays session-scoped alongside the stories.
 */
export interface PrdReconciliationConfig {
  /** Per-story observable-evidence checks. A story reconciles only when ALL of its checks pass. */
  observableChecks?: Record<string, ObservableCheck[]>;
  /** Age (ms) after which an unfinished PRD counts as stale even without an abnormal-exit signal. */
  staleAfterMs?: number;
  /** Auto-reconcile stories whose checks all pass (default true when checks exist). */
  autoReconcile?: boolean;
}

/** Signals that a PRD may have diverged from observable reality. */
export interface StalePrdDetection {
  /** True when the PRD has unfinished stories AND at least one stale signal applies. */
  stale: boolean;
  /** Human-readable reasons for the stale verdict. */
  reasons: string[];
  /** True when the session's ralph loop state is still active (Step 8 cancel never ran). */
  abnormalExit: boolean;
  /** Story IDs never marked passes:true — the divergence-relevant set (#3669). Stories awaiting Step 7 review (passes:true) are normal pipeline, not stale. */
  unfinished: string[];
  /** Total story count. */
  total: number;
  /** Completed story count. */
  completed: number;
  /** Milliseconds since the PRD file was last written. */
  ageMs: number;
  /** ISO timestamp of the last PRD write, when known. */
  lastTouchedAt: string | null;
  /** Stale-pointer signals, e.g. the PRD's branchName no longer exists or was merged. */
  stalePointers: string[];
  /** Absolute path of the PRD file that was inspected. */
  prdPath: string;
}

/** One audited reconciliation decision. */
export interface ReconciliationAuditEntry {
  timestamp: string;
  sessionId?: string;
  storyId: string;
  decision: 'reconciled' | 'skipped';
  previousPasses: boolean;
  newPasses: boolean;
  checks: { check: ObservableCheck; passed: boolean; detail?: string }[];
  evidence: string;
  reason?: string;
}

/** Outcome of a bounded reconciliation pass. */
export interface ReconcileStalePrdResult {
  detection: StalePrdDetection;
  /** Story IDs marked `passes: true` from passing observable evidence. */
  reconciled: string[];
  /** Story IDs left unfinished, with the reason. */
  skipped: { storyId: string; reason: string }[];
  /** Absolute path of the audit log (null when nothing was audited). */
  auditPath: string | null;
  /** Remaining stale warning, or null when no unfinished story is left to warn about. */
  warning: string | null;
}

export interface ObservableCheckResult {
  passed: boolean;
  detail: string;
}

// ============================================================================
// Observable checks (bounded, content-based)
// ============================================================================

function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

function resolveCheckPath(directory: string, checkPath: string): string | null {
  // File checks are anchored at the project/worktree root the caller means
  // (in production the git worktree root; in tests the temp project dir) — the
  // same root git commands run against. Confinement prevents a configured check
  // from reading outside the project.
  const root = resolve(directory);
  const candidate = resolve(root, checkPath);
  return isPathWithinRoot(root, candidate) ? candidate : null;
}

function runGit(args: string[], directory: string): { exitCode: number; detail: string } {
  try {
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf-8',
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { exitCode: 0, detail: '' };
  } catch (error) {
    const err = error as { status?: number; stderr?: string | Buffer; message?: string };
    if (typeof err.status === 'number' && err.status !== 0) {
      // git grep exits 1 when no match; git merge-base --is-ancestor exits 1 when not an ancestor.
      return { exitCode: err.status, detail: err.status === 1 ? '' : String(err.stderr ?? '') };
    }
    return { exitCode: -1, detail: err.message ?? String(error) };
  }
}

function checkFileExists(check: ObservableCheck, directory: string): ObservableCheckResult {
  if (!check.path) {
    return { passed: false, detail: 'fileExists check requires a path' };
  }
  const resolved = resolveCheckPath(directory, check.path);
  if (!resolved) {
    return { passed: false, detail: `path escapes repository root: ${check.path}` };
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return { passed: false, detail: `file not found: ${check.path}` };
  }
  return { passed: true, detail: `file exists: ${check.path}` };
}

function checkFileContains(check: ObservableCheck, directory: string): ObservableCheckResult {
  const fileResult = checkFileExists(check, directory);
  if (!fileResult.passed) {
    return fileResult;
  }
  if (!check.pattern) {
    return { passed: false, detail: 'fileContains check requires a pattern' };
  }
  const resolved = resolveCheckPath(directory, check.path as string) as string;
  try {
    const content = readFileSync(resolved, 'utf-8');
    return content.includes(check.pattern)
      ? { passed: true, detail: `pattern found in ${check.path}` }
      : { passed: false, detail: `pattern not found in ${check.path}` };
  } catch (error) {
    return { passed: false, detail: `failed to read ${check.path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function checkGitGrep(check: ObservableCheck, directory: string): ObservableCheckResult {
  if (!check.pattern) {
    return { passed: false, detail: 'gitGrep check requires a pattern' };
  }
  const ref = check.ref ?? 'HEAD';
  const result = runGit(['grep', '-q', '-e', check.pattern, ref], directory);
  if (result.exitCode === 0) {
    return { passed: true, detail: `git grep ${check.pattern} at ${ref}: found` };
  }
  if (result.exitCode === 1) {
    return { passed: false, detail: `git grep ${check.pattern} at ${ref}: not found` };
  }
  return { passed: false, detail: `git grep failed: ${result.detail || 'git unavailable'}` };
}

/**
 * Run a single observable check. All checks are bounded and fail closed.
 */
export function runObservableCheck(check: ObservableCheck, directory: string): ObservableCheckResult {
  switch (check.type) {
    case 'fileExists':
      return checkFileExists(check, directory);
    case 'fileContains':
      return checkFileContains(check, directory);
    case 'gitGrep':
      return checkGitGrep(check, directory);
    default:
      return { passed: false, detail: `unknown check type: ${(check as { type: string }).type}` };
  }
}

// ============================================================================
// Stale detection
// ============================================================================

function isGitRepository(directory: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: directory,
      encoding: 'utf-8',
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function currentBranch(directory: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: directory,
      encoding: 'utf-8',
      timeout: CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

function branchExists(directory: string, branch: string): boolean {
  const result = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], directory);
  if (result.exitCode === 0) {
    return true;
  }
  const remoteResult = runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], directory);
  return remoteResult.exitCode === 0;
}

function isBranchMergedIntoHead(directory: string, branch: string): boolean {
  const result = runGit(['merge-base', '--is-ancestor', branch, 'HEAD'], directory);
  return result.exitCode === 0;
}

/**
 * Detect whether the active PRD has diverged from observable reality.
 *
 * Returns null when no PRD exists. A returned detection always carries the full
 * picture even when `stale` is false (callers use `unfinished` to decide whether
 * an exit-time warning is warranted).
 *
 * `includeAbnormalExit` (default true) treats a still-active ralph loop state
 * as an abnormal-exit signal. The live-loop continuation path passes false —
 * while the loop is legitimately running, an active state is the normal case,
 * so only age and stale-pointer signals count there.
 */
export function detectStalePrd(
  directory: string,
  sessionId?: string,
  options?: { includeAbnormalExit?: boolean },
): StalePrdDetection | null {
  const includeAbnormalExit = options?.includeAbnormalExit !== false;
  const prdPath = findPrdPath(directory, sessionId);
  if (!prdPath) {
    return null;
  }

  const prd = readPrd(directory, sessionId);
  if (!prd) {
    return null;
  }

  let ageMs = 0;
  let lastTouchedAt: string | null = null;
  try {
    const stat = statSync(prdPath);
    ageMs = Date.now() - stat.mtimeMs;
    lastTouchedAt = new Date(stat.mtimeMs).toISOString();
  } catch {
    // Unreadable file: age unknown, treated as fresh so detection stays conservative.
  }

  const unfinished = prd.userStories.filter(s => s.passes !== true).map(s => s.id);
  const total = prd.userStories.length;
  const completed = total - unfinished.length;

  const reasons: string[] = [];
  const stalePointers: string[] = [];

  // Abnormal exit: the ralph loop state for this session is still active, so
  // Step 8 (`/oh-my-claudecode:cancel`) never ran.
  const ralphState = readModeState<{ active?: boolean }>('ralph', directory, sessionId);
  const abnormalExit = includeAbnormalExit && ralphState?.active === true;
  if (abnormalExit) {
    reasons.push('Ralph loop state is still active (Step 8 cancel never ran)');
  }

  const staleAfterMs = prd.reconciliation?.staleAfterMs ?? DEFAULT_STALE_PRD_AFTER_MS;
  if (ageMs > staleAfterMs) {
    reasons.push(`PRD was last touched ${formatAge(ageMs)} ago`);
  }

  // Stale pointers: the PRD's branchName no longer exists or has been merged
  // into the current branch. Detection signal only — never completion evidence.
  if (prd.branchName && isGitRepository(directory)) {
    const head = currentBranch(directory);
    if (head !== prd.branchName) {
      if (!branchExists(directory, prd.branchName)) {
        stalePointers.push(`branch "${prd.branchName}" no longer exists`);
      } else if (isBranchMergedIntoHead(directory, prd.branchName)) {
        stalePointers.push(`branch "${prd.branchName}" is already merged into ${head ?? 'HEAD'}`);
      }
    }
  }
  if (stalePointers.length > 0) {
    reasons.push('stale pointer(s): ' + stalePointers.join('; '));
  }

  const stale = unfinished.length > 0 && reasons.length > 0;

  return {
    stale,
    reasons,
    abnormalExit,
    unfinished,
    total,
    completed,
    ageMs,
    lastTouchedAt,
    stalePointers,
    prdPath,
  };
}

// ============================================================================
// Audit trail
// ============================================================================

function getAuditLogPath(directory: string, sessionId?: string): string {
  if (sessionId) {
    ensureSessionStateDir(sessionId, directory);
    return resolve(getSessionStateDir(sessionId, directory), PRD_RECONCILIATION_AUDIT_FILENAME);
  }
  const stateDir = resolve(getOmcRoot(directory), 'state');
  if (!existsSync(stateDir)) {
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      // Audit is best-effort; callers treat a missing log as null.
    }
  }
  return resolve(stateDir, PRD_RECONCILIATION_AUDIT_FILENAME);
}

function appendAuditEntry(directory: string, entry: ReconciliationAuditEntry, sessionId?: string): string | null {
  const auditPath = getAuditLogPath(directory, sessionId);
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf-8');
    return auditPath;
  } catch {
    return null;
  }
}

// ============================================================================
// Warning formatting
// ============================================================================

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'less than a minute';
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0
    ? `${hours} hour${hours === 1 ? '' : 's'}`
    : `${hours} hour${hours === 1 ? '' : 's'} ${remMinutes} minute${remMinutes === 1 ? '' : 's'}`;
}

/**
 * Format an explicit stale-unfinished-PRD warning. Surfaces the divergence at
 * the moment it is cheapest to fix: abnormal/non-Step 8 exit and Ralph startup.
 */
export function formatStalePrdWarning(detection: StalePrdDetection): string {
  const { unfinished, total, completed } = detection;
  const storyList = unfinished.length > 0 ? ` (${unfinished.join(', ')})` : '';
  const touched = detection.lastTouchedAt
    ? ` and was last touched ${formatAge(detection.ageMs)} ago`
    : '';
  const reasons = detection.reasons.length > 0
    ? ` Signals: ${detection.reasons.join('; ')}.`
    : '';

  const lines = [
    `[STALE PRD WARNING] prd.json (${detection.prdPath}) has ${unfinished.length}/${total} unfinished stories${storyList}, ${completed}/${total} complete${touched}.${reasons}`,
    `Ralph completion is only recorded when a story is marked passes:true in prd.json (Step 5); work landed outside the loop (e.g. campaign PRs) or an abnormal/non-Step 8 exit leaves this file stale.`,
    `Do NOT treat these stories as outstanding — verify against observable state (merged PR content, files on trunk) before redoing them. Configure observableChecks under prd.reconciliation to auto-reconcile from content evidence.`,
  ];

  return lines.join('\n');
}

// ============================================================================
// Reconciliation
// ============================================================================

function buildEvidence(checks: ObservableCheck[], results: ObservableCheckResult[]): string {
  return checks
    .map((check, i) => {
      const label = check.description ?? `${check.type}${check.path ? ` ${check.path}` : ''}${check.pattern ? ` ${check.pattern}` : ''}`;
      return `${label}: ${results[i].passed ? 'PASS' : 'FAIL'}${results[i].detail ? ` (${results[i].detail})` : ''}`;
    })
    .join('; ');
}

/**
 * Bounded stale-state reconciliation.
 *
 * A story is marked `passes: true` ONLY when the PRD carries configured
 * observable evidence for it and every configured check passes. Stories without
 * configured evidence, or with failing checks, are left untouched. Every
 * decision is audited. Never infers completion from PR/merge status.
 */
export function reconcileStalePrd(directory: string, sessionId?: string): ReconcileStalePrdResult | null {
  const detection = detectStalePrd(directory, sessionId);
  if (!detection || !detection.stale) {
    return detection ? { detection, reconciled: [], skipped: [], auditPath: null, warning: null } : null;
  }

  const prd = readPrd(directory, sessionId);
  if (!prd) {
    return null;
  }

  const checksByStory = prd.reconciliation?.observableChecks ?? {};
  const autoReconcile = prd.reconciliation?.autoReconcile !== false;
  const reconciled: string[] = [];
  const skipped: { storyId: string; reason: string }[] = [];
  let auditPath: string | null = null;
  const entries: ReconciliationAuditEntry[] = [];

  for (const story of prd.userStories) {
    // Reconciliation repairs Step 5: it only ever touches stories that were
    // never marked passes:true. Stories already passes:true (even while
    // awaiting Step 7 review) are part of the normal pipeline, not stale.
    if (story.passes === true) {
      continue;
    }

    const checks = checksByStory[story.id];
    if (!checks || checks.length === 0) {
      skipped.push({ storyId: story.id, reason: 'no configured observable evidence (prd.reconciliation.observableChecks)' });
      entries.push({
        timestamp: new Date().toISOString(),
        sessionId,
        storyId: story.id,
        decision: 'skipped',
        previousPasses: story.passes,
        newPasses: story.passes,
        checks: [],
        evidence: '',
        reason: 'no configured observable evidence',
      });
      continue;
    }

    const results = checks.map(check => runObservableCheck(check, directory));
    const allPass = results.every(r => r.passed);
    const evidence = buildEvidence(checks, results);

    if (autoReconcile && allPass) {
      story.passes = true;
      story.architectVerified = false;
      story.notes = appendStoryNote(story.notes, `Reconciled from observable evidence on ${new Date().toISOString()}: ${evidence}`);
      reconciled.push(story.id);
      entries.push({
        timestamp: new Date().toISOString(),
        sessionId,
        storyId: story.id,
        decision: 'reconciled',
        previousPasses: false,
        newPasses: true,
        checks: checks.map((check, i) => ({ check, passed: results[i].passed, detail: results[i].detail })),
        evidence,
      });
    } else {
      skipped.push({
        storyId: story.id,
        reason: autoReconcile ? `observable evidence check failed: ${evidence}` : 'autoReconcile disabled',
      });
      entries.push({
        timestamp: new Date().toISOString(),
        sessionId,
        storyId: story.id,
        decision: 'skipped',
        previousPasses: story.passes,
        newPasses: story.passes,
        checks: checks.map((check, i) => ({ check, passed: results[i].passed, detail: results[i].detail })),
        evidence,
        reason: autoReconcile ? 'observable evidence check failed' : 'autoReconcile disabled',
      });
    }
  }

  const prdChanged = reconciled.length > 0;
  if (prdChanged && !writePrd(directory, prd, sessionId)) {
    // Write failure: do not claim success. The audit log records the true
    // outcome (nothing changed) so it cannot be misread as a completed run.
    for (const entry of entries) {
      if (entry.decision === 'reconciled') {
        entry.decision = 'skipped';
        entry.newPasses = entry.previousPasses;
        entry.reason = 'prd write failed after checks passed';
      }
      const path = appendAuditEntry(directory, entry, sessionId);
      if (path) auditPath = path;
    }
    return {
      detection,
      reconciled: [],
      skipped: [...skipped, ...reconciled.map(storyId => ({ storyId, reason: 'prd write failed after checks passed' }))],
      auditPath,
      warning: formatStalePrdWarning(detection),
    };
  }

  for (const entry of entries) {
    const path = appendAuditEntry(directory, entry, sessionId);
    if (path) auditPath = path;
  }

  const remaining = prd.userStories.filter(s => s.passes !== true).map(s => s.id);
  const warning =
    remaining.length > 0
      ? formatStalePrdWarning({ ...detection, unfinished: remaining, completed: prd.userStories.length - remaining.length, stale: true })
      : null;

  return { detection, reconciled, skipped, auditPath, warning };
}

function appendStoryNote(notes: string | undefined, addition: string): string {
  return notes ? `${notes}\n${addition}` : addition;
}

/**
 * Session-end integration: returns the stale-unfinished-PRD warning for the
 * ending session, or null when there is nothing to warn about. Must be called
 * BEFORE mode-state cleanup removes the ralph state file (the abnormal-exit
 * signal). Never throws; session end must never be blocked by this check.
 */
export function getSessionEndStalePrdWarning(directory: string, sessionId: string): string | null {
  try {
    const detection = detectStalePrd(directory, sessionId);
    if (!detection || detection.unfinished.length === 0) {
      return null;
    }
    return formatStalePrdWarning(detection);
  } catch {
    return null;
  }
}

/**
 * Ralph startup/resume integration: detect a stale PRD, reconcile it when
 * configured observable evidence exists, and surface the remaining warning.
 * Never throws; ralph startup must not be blocked by this check.
 */
export function reconcileStalePrdForStartup(directory: string, sessionId?: string): { warning: string | null } {
  try {
    const result = reconcileStalePrd(directory, sessionId);
    return { warning: result?.warning ?? null };
  } catch {
    return { warning: null };
  }
}

