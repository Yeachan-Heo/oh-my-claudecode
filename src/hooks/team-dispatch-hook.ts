/**
 * Team dispatch hook: drain pending dispatch requests via tmux injection.
 *
 * Mirrors OMX scripts/notify-hook/team-dispatch.js behavior exactly.
 *
 * Called on every leader hook tick. Workers skip (OMC_TEAM_WORKER set).
 * Processes pending dispatch requests with:
 * - Hook-preferred transport only (skips transport_direct, prompt_stdin)
 * - Post-injection verification (3 rounds x 250ms)
 * - Issue cooldown (15 min per issue key)
 * - Trigger cooldown (30s per trigger text)
 * - Max unconfirmed attempts (3) before marking failed
 * - Leader pane missing -> deferred
 */

import { readFile, writeFile, mkdir, readdir, appendFile, rename, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

// ── Helpers ────────────────────────────────────────────────────────────────

function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

// ── Constants ──────────────────────────────────────────────────────────────

const DISPATCH_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_ISSUE_DISPATCH_COOLDOWN_MS = 15 * 60 * 1000;
const ISSUE_DISPATCH_COOLDOWN_ENV = 'OMC_TEAM_DISPATCH_ISSUE_COOLDOWN_MS';
const DEFAULT_DISPATCH_TRIGGER_COOLDOWN_MS = 30 * 1000;
const DISPATCH_TRIGGER_COOLDOWN_ENV = 'OMC_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS';
const LEADER_PANE_MISSING_DEFERRED_REASON = 'leader_pane_missing_deferred';
const LEADER_NOTIFICATION_DEFERRED_TYPE = 'leader_notification_deferred';
const INJECT_VERIFY_DELAY_MS = 250;
const INJECT_VERIFY_ROUNDS = 3;
const MAX_UNCONFIRMED_ATTEMPTS = 3;

// ── Env resolvers ──────────────────────────────────────────────────────────

function resolveIssueDispatchCooldownMs(env = process.env): number {
  const raw = safeString(env[ISSUE_DISPATCH_COOLDOWN_ENV]).trim();
  if (raw === '') return DEFAULT_ISSUE_DISPATCH_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ISSUE_DISPATCH_COOLDOWN_MS;
  return parsed;
}

function resolveDispatchTriggerCooldownMs(env = process.env): number {
  const raw = safeString(env[DISPATCH_TRIGGER_COOLDOWN_ENV]).trim();
  if (raw === '') return DEFAULT_DISPATCH_TRIGGER_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DISPATCH_TRIGGER_COOLDOWN_MS;
  return parsed;
}

function extractIssueKey(triggerMessage: string): string | null {
  const match = safeString(triggerMessage).match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function normalizeTriggerKey(value: string): string {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

// ── Lock ───────────────────────────────────────────────────────────────────

async function withDispatchLock<T>(teamDirPath: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(teamDirPath, 'dispatch', '.lock');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5_000;
  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > DISPATCH_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch { /* best effort */ }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring dispatch lock for ${teamDirPath}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}

async function withMailboxLock<T>(teamDirPath: string, workerName: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(teamDirPath, 'mailbox', `.lock-${workerName}`);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5_000;
  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > DISPATCH_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch { /* best effort */ }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring mailbox lock for ${teamDirPath}/${workerName}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}

// ── Cooldown state ─────────────────────────────────────────────────────────

function issueCooldownStatePath(teamDirPath: string): string {
  return join(teamDirPath, 'dispatch', 'issue-cooldown.json');
}

function triggerCooldownStatePath(teamDirPath: string): string {
  return join(teamDirPath, 'dispatch', 'trigger-cooldown.json');
}

interface IssueCooldownState {
  by_issue: Record<string, number>;
}

interface TriggerCooldownState {
  by_trigger: Record<string, { at: number; last_request_id: string } | number>;
}

async function readIssueCooldownState(teamDirPath: string): Promise<IssueCooldownState> {
  const fallback: IssueCooldownState = { by_issue: {} };
  const parsed = await readJson(issueCooldownStatePath(teamDirPath), fallback);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.by_issue !== 'object' || parsed.by_issue === null) {
    return fallback;
  }
  return parsed;
}

async function readTriggerCooldownState(teamDirPath: string): Promise<TriggerCooldownState> {
  const fallback: TriggerCooldownState = { by_trigger: {} };
  const parsed = await readJson(triggerCooldownStatePath(teamDirPath), fallback);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.by_trigger !== 'object' || parsed.by_trigger === null) {
    return fallback;
  }
  return parsed;
}

function parseTriggerCooldownEntry(entry: unknown): { at: number; lastRequestId: string } {
  if (typeof entry === 'number') {
    return { at: entry, lastRequestId: '' };
  }
  if (!entry || typeof entry !== 'object') {
    return { at: NaN, lastRequestId: '' };
  }
  return {
    at: Number((entry as Record<string, unknown>).at),
    lastRequestId: safeString((entry as Record<string, unknown>).last_request_id).trim(),
  };
}

// ── Dispatch request types ─────────────────────────────────────────────────

interface DispatchRequest {
  request_id: string;
  kind: string;
  team_name: string;
  to_worker: string;
  worker_index?: number;
  pane_id?: string;
  trigger_message: string;
  message_id?: string;
  transport_preference: string;
  fallback_allowed: boolean;
  status: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  notified_at?: string;
  delivered_at?: string;
  failed_at?: string;
  last_reason?: string;
}

interface TeamConfig {
  workers?: Array<{ name: string; index?: number; pane_id?: string; worker_cli?: string }>;
  tmux_session?: string;
  leader_pane_id?: string;
}

// ── Injection ──────────────────────────────────────────────────────────────

export interface InjectionResult {
  ok: boolean;
  reason: string;
  pane?: string;
}

export type Injector = (request: DispatchRequest, config: TeamConfig, cwd: string) => Promise<InjectionResult>;

function defaultInjectTarget(
  request: DispatchRequest,
  config: TeamConfig,
): { type: string; value: string } | null {
  if (request.to_worker === 'leader-fixed') {
    if (config.leader_pane_id) return { type: 'pane', value: config.leader_pane_id };
    return null;
  }
  if (request.pane_id) return { type: 'pane', value: request.pane_id };
  if (typeof request.worker_index === 'number' && Array.isArray(config.workers)) {
    const worker = config.workers.find((c) => Number(c.index) === request.worker_index);
    if (worker?.pane_id) return { type: 'pane', value: worker.pane_id };
  }
  if (typeof request.worker_index === 'number' && config.tmux_session) {
    return { type: 'pane', value: `${config.tmux_session}.${request.worker_index}` };
  }
  if (config.tmux_session) return { type: 'session', value: config.tmux_session };
  return null;
}

function normalizeCaptureText(value: string): string {
  return safeString(value).replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function capturedPaneContainsTrigger(captured: string, trigger: string): boolean {
  if (!captured || !trigger) return false;
  return normalizeCaptureText(captured).includes(normalizeCaptureText(trigger));
}

function capturedPaneContainsTriggerNearTail(captured: string, trigger: string, nonEmptyTailLines = 24): boolean {
  if (!captured || !trigger) return false;
  const normalizedTrigger = normalizeCaptureText(trigger);
  if (!normalizedTrigger) return false;
  const lines = safeString(captured)
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const tail = lines.slice(-Math.max(1, nonEmptyTailLines)).join(' ');
  return normalizeCaptureText(tail).includes(normalizedTrigger);
}

function paneHasActiveTask(captured: string): boolean {
  const lines = safeString(captured)
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-40);
  if (tail.some((line) => /\b\d+\s+background terminal running\b/i.test(line))) return true;
  if (tail.some((line) => /esc to interrupt/i.test(line))) return true;
  if (tail.some((line) => /\bbackground terminal running\b/i.test(line))) return true;
  if (tail.some((line) => /^[·✻]\s+[A-Za-z][A-Za-z0-9''-]*(?:\s+[A-Za-z][A-Za-z0-9''-]*){0,3}(?:…|\.{3})$/u.test(line))) return true;
  return false;
}

function paneIsBootstrapping(captured: string): boolean {
  const lines = safeString(captured)
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  return lines.some((line) =>
    /\b(loading|initializing|starting up)\b/i.test(line)
    || /\bmodel:\s*loading\b/i.test(line)
    || /\bconnecting\s+to\b/i.test(line),
  );
}

function paneLooksReady(captured: string): boolean {
  const content = safeString(captured).trimEnd();
  if (content === '') return false;
  const lines = content
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trimEnd())
    .filter((line) => line.trim() !== '');
  if (paneIsBootstrapping(content)) return false;
  const lastLine = lines.length > 0 ? lines[lines.length - 1]! : '';
  if (/^\s*[›>❯]\s*/u.test(lastLine)) return true;
  const hasCodexPromptLine = lines.some((line) => /^\s*›\s*/u.test(line));
  const hasClaudePromptLine = lines.some((line) => /^\s*❯\s*/u.test(line));
  if (hasCodexPromptLine || hasClaudePromptLine) return true;
  return false;
}

function resolveWorkerCliForRequest(request: DispatchRequest, config: TeamConfig): string {
  const workers = Array.isArray(config.workers) ? config.workers : [];
  const idx = Number.isFinite(request.worker_index) ? Number(request.worker_index) : null;
  if (idx !== null) {
    const worker = workers.find((c) => Number(c.index) === idx);
    const workerCli = safeString(worker?.worker_cli).trim().toLowerCase();
    if (workerCli === 'claude') return 'claude';
  }
  return 'codex';
}

async function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const result = await execFileAsync(cmd, args, { timeout: timeoutMs });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function defaultInjector(request: DispatchRequest, config: TeamConfig, cwd: string): Promise<InjectionResult> {
  const target = defaultInjectTarget(request, config);
  if (!target) return { ok: false, reason: 'missing_tmux_target' };

  const paneTarget = target.value;
  try {
    const inMode = await runProcess('tmux', ['display-message', '-t', paneTarget, '-p', '#{pane_in_mode}'], 1000);
    if (safeString(inMode.stdout).trim() === '1') {
      return { ok: false, reason: 'scroll_active' };
    }
  } catch { /* best effort */ }

  const submitKeyPresses = resolveWorkerCliForRequest(request, config) === 'claude' ? 1 : 2;
  const attemptCountAtStart = Number.isFinite(request.attempt_count) ? Math.max(0, Math.floor(request.attempt_count)) : 0;

  let preCaptureHasTrigger = false;
  if (attemptCountAtStart >= 1) {
    try {
      const preCapture = await runProcess('tmux', ['capture-pane', '-t', paneTarget, '-p', '-S', '-8'], 2000);
      preCaptureHasTrigger = capturedPaneContainsTrigger(preCapture.stdout, request.trigger_message);
    } catch {
      preCaptureHasTrigger = false;
    }
  }

  const shouldTypePrompt = attemptCountAtStart === 0 || !preCaptureHasTrigger;
  if (shouldTypePrompt) {
    if (attemptCountAtStart >= 1) {
      await runProcess('tmux', ['send-keys', '-t', paneTarget, 'C-u'], 1000).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
    }
    await runProcess('tmux', ['send-keys', '-t', paneTarget, '-l', request.trigger_message], 3000);
  }

  for (let i = 0; i < submitKeyPresses; i++) {
    await runProcess('tmux', ['send-keys', '-t', paneTarget, 'C-m'], 3000);
    if (i < submitKeyPresses - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Post-injection verification
  for (let round = 0; round < INJECT_VERIFY_ROUNDS; round++) {
    await new Promise((r) => setTimeout(r, INJECT_VERIFY_DELAY_MS));
    try {
      const narrowCap = await runProcess('tmux', ['capture-pane', '-t', paneTarget, '-p', '-S', '-8'], 2000);
      const wideCap = await runProcess('tmux', ['capture-pane', '-t', paneTarget, '-p'], 2000);

      if (paneHasActiveTask(wideCap.stdout)) {
        return { ok: true, reason: 'tmux_send_keys_confirmed_active_task', pane: paneTarget };
      }
      if (request.to_worker !== 'leader-fixed' && !paneLooksReady(wideCap.stdout)) {
        continue;
      }
      const triggerInNarrow = capturedPaneContainsTrigger(narrowCap.stdout, request.trigger_message);
      const triggerNearTail = capturedPaneContainsTriggerNearTail(wideCap.stdout, request.trigger_message);
      if (!triggerInNarrow && !triggerNearTail) {
        return { ok: true, reason: 'tmux_send_keys_confirmed', pane: paneTarget };
      }
    } catch { /* capture failed; retry */ }

    for (let i = 0; i < submitKeyPresses; i++) {
      await runProcess('tmux', ['send-keys', '-t', paneTarget, 'C-m'], 3000).catch(() => {});
    }
  }

  return { ok: true, reason: 'tmux_send_keys_unconfirmed', pane: paneTarget };
}

// ── Mailbox update ─────────────────────────────────────────────────────────

async function updateMailboxNotified(stateDir: string, teamName: string, workerName: string, messageId: string): Promise<boolean> {
  const teamDirPath = join(stateDir, 'team', teamName);
  const mailboxPath = join(teamDirPath, 'mailbox', `${workerName}.json`);
  const legacyMailboxPath = join(teamDirPath, 'mailbox', `${workerName}.jsonl`);
  return await withMailboxLock(teamDirPath, workerName, async () => {
    const canonical = await readJson<{ worker: string; messages: Array<Record<string, unknown>> }>(mailboxPath, { worker: workerName, messages: [] });
    if (canonical && Array.isArray(canonical.messages)) {
      const msg = canonical.messages.find((c) => c?.message_id === messageId);
      if (msg) {
        if (!msg.notified_at) msg.notified_at = new Date().toISOString();
        await writeJsonAtomic(mailboxPath, canonical);
        return true;
      }
    }

    // Legacy fallback: mailbox/*.jsonl
    if (!existsSync(legacyMailboxPath)) return false;
    try {
      const raw = await readFile(legacyMailboxPath, 'utf8');
      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
      const messagesById = new Map<string, Record<string, unknown>>();
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const candidate = parsed as Record<string, unknown>;
        const id = safeString(candidate.message_id || candidate.id).trim();
        if (!id) continue;
        messagesById.set(id, candidate);
      }
      const message = messagesById.get(messageId);
      if (!message) return false;
      if (!message.notified_at) {
        message.notified_at = new Date().toISOString();
      }
      const normalizedMessages = [...messagesById.values()].map((candidate) => ({
        message_id: safeString(candidate.message_id || candidate.id),
        from_worker: safeString(candidate.from_worker || candidate.from),
        to_worker: safeString(candidate.to_worker || candidate.to),
        body: safeString(candidate.body),
        created_at: safeString(candidate.created_at || candidate.createdAt),
        ...(safeString(candidate.notified_at || candidate.notifiedAt) ? { notified_at: safeString(candidate.notified_at || candidate.notifiedAt) } : {}),
        ...(safeString(candidate.delivered_at || candidate.deliveredAt) ? { delivered_at: safeString(candidate.delivered_at || candidate.deliveredAt) } : {}),
      }));
      await writeJsonAtomic(mailboxPath, { worker: workerName, messages: normalizedMessages });
      return true;
    } catch {
      return false;
    }
  });
}

// ── Event logging ──────────────────────────────────────────────────────────

async function appendDispatchLog(logsDir: string, event: Record<string, unknown>): Promise<void> {
  const path = join(logsDir, `team-dispatch-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`).catch(() => {});
}

async function appendLeaderNotificationDeferredEvent(params: {
  stateDir: string;
  teamName: string;
  request: DispatchRequest;
  reason: string;
  nowIso: string;
}): Promise<void> {
  const eventsDir = join(params.stateDir, 'team', params.teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  const event = {
    event_id: `leader-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    team: params.teamName,
    type: LEADER_NOTIFICATION_DEFERRED_TYPE,
    worker: params.request.to_worker,
    to_worker: params.request.to_worker,
    reason: params.reason,
    created_at: params.nowIso,
    request_id: params.request.request_id,
    ...(params.request.message_id ? { message_id: params.request.message_id } : {}),
  };
  await mkdir(eventsDir, { recursive: true }).catch(() => {});
  await appendFile(eventsPath, JSON.stringify(event) + '\n').catch(() => {});
}

// ── Main export ────────────────────────────────────────────────────────────

function shouldSkipRequest(request: DispatchRequest): boolean {
  if (request.status !== 'pending') return true;
  return request.transport_preference !== 'hook_preferred_with_fallback';
}

export interface DrainResult {
  processed: number;
  skipped: number;
  failed: number;
  reason?: string;
}

export async function drainPendingTeamDispatch(options: {
  cwd: string;
  stateDir?: string;
  logsDir?: string;
  maxPerTick?: number;
  injector?: Injector;
} = { cwd: '' }): Promise<DrainResult> {
  const { cwd } = options;
  const stateDir = options.stateDir ?? join(cwd, '.omc', 'state');
  const logsDir = options.logsDir ?? join(cwd, '.omc', 'logs');
  const maxPerTick = options.maxPerTick ?? 5;
  const injector = options.injector ?? defaultInjector;

  if (safeString(process.env.OMC_TEAM_WORKER)) {
    return { processed: 0, skipped: 0, failed: 0, reason: 'worker_context' };
  }
  const teamRoot = join(stateDir, 'team');
  if (!existsSync(teamRoot)) return { processed: 0, skipped: 0, failed: 0 };

  let teams: string[] = [];
  try {
    teams = await readdir(teamRoot);
  } catch {
    return { processed: 0, skipped: 0, failed: 0 };
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const issueCooldownMs = resolveIssueDispatchCooldownMs();
  const triggerCooldownMs = resolveDispatchTriggerCooldownMs();

  for (const teamName of teams) {
    if (processed >= maxPerTick) break;
    const teamDirPath = join(teamRoot, teamName);
    const manifestPath = join(teamDirPath, 'manifest.v2.json');
    const configPath = join(teamDirPath, 'config.json');
    const requestsPath = join(teamDirPath, 'dispatch', 'requests.json');
    if (!existsSync(requestsPath)) continue;

    const config = await readJson<TeamConfig>(existsSync(manifestPath) ? manifestPath : configPath, {});
    await withDispatchLock(teamDirPath, async () => {
      const requests = await readJson<DispatchRequest[]>(requestsPath, []);
      if (!Array.isArray(requests)) return;
      const issueCooldownState = await readIssueCooldownState(teamDirPath);
      const triggerCooldownState = await readTriggerCooldownState(teamDirPath);
      const issueCooldownByIssue = issueCooldownState.by_issue || {};
      const triggerCooldownByKey = triggerCooldownState.by_trigger || {};
      const nowMs = Date.now();

      let mutated = false;
      for (const request of requests) {
        if (processed >= maxPerTick) break;
        if (!request || typeof request !== 'object') continue;
        if (shouldSkipRequest(request)) {
          skipped += 1;
          continue;
        }

        // Leader pane missing -> defer
        if (request.to_worker === 'leader-fixed' && !safeString(config.leader_pane_id).trim()) {
          const nowIso = new Date().toISOString();
          request.updated_at = nowIso;
          request.last_reason = LEADER_PANE_MISSING_DEFERRED_REASON;
          request.status = 'pending';
          skipped += 1;
          mutated = true;
          await appendDispatchLog(logsDir, {
            type: 'dispatch_deferred',
            team: teamName,
            request_id: request.request_id,
            worker: request.to_worker,
            to_worker: request.to_worker,
            message_id: request.message_id || null,
            reason: LEADER_PANE_MISSING_DEFERRED_REASON,
            status: 'pending',
            tmux_injection_attempted: false,
          });
          await appendLeaderNotificationDeferredEvent({
            stateDir,
            teamName,
            request,
            reason: LEADER_PANE_MISSING_DEFERRED_REASON,
            nowIso,
          });
          continue;
        }

        // Issue cooldown
        const issueKey = extractIssueKey(request.trigger_message);
        if (issueCooldownMs > 0 && issueKey) {
          const lastInjectedMs = Number(issueCooldownByIssue[issueKey]);
          if (Number.isFinite(lastInjectedMs) && lastInjectedMs > 0 && nowMs - lastInjectedMs < issueCooldownMs) {
            skipped += 1;
            continue;
          }
        }

        // Trigger cooldown
        const triggerKey = normalizeTriggerKey(request.trigger_message);
        if (triggerCooldownMs > 0 && triggerKey) {
          const parsed = parseTriggerCooldownEntry(triggerCooldownByKey[triggerKey]);
          const withinCooldown = Number.isFinite(parsed.at) && parsed.at > 0 && nowMs - parsed.at < triggerCooldownMs;
          const sameRequestRetry = parsed.lastRequestId !== '' && parsed.lastRequestId === safeString(request.request_id).trim();
          if (withinCooldown && !sameRequestRetry) {
            skipped += 1;
            continue;
          }
        }

        const result = await injector(request, config, resolve(cwd));
        if (issueKey && issueCooldownMs > 0) {
          issueCooldownByIssue[issueKey] = Date.now();
          mutated = true;
        }
        if (triggerKey && triggerCooldownMs > 0) {
          triggerCooldownByKey[triggerKey] = {
            at: Date.now(),
            last_request_id: safeString(request.request_id).trim(),
          };
          mutated = true;
        }
        const nowIso = new Date().toISOString();
        request.attempt_count = Number.isFinite(request.attempt_count) ? Math.max(0, request.attempt_count + 1) : 1;
        request.updated_at = nowIso;

        if (result.ok) {
          // Unconfirmed: retry up to MAX_UNCONFIRMED_ATTEMPTS
          if (result.reason === 'tmux_send_keys_unconfirmed' && request.attempt_count < MAX_UNCONFIRMED_ATTEMPTS) {
            request.last_reason = result.reason;
            mutated = true;
            skipped += 1;
            await appendDispatchLog(logsDir, {
              type: 'dispatch_unconfirmed_retry',
              team: teamName,
              request_id: request.request_id,
              worker: request.to_worker,
              attempt: request.attempt_count,
              reason: result.reason,
            });
            continue;
          }
          if (result.reason === 'tmux_send_keys_unconfirmed') {
            request.status = 'failed';
            request.failed_at = nowIso;
            request.last_reason = 'unconfirmed_after_max_retries';
            processed += 1;
            failed += 1;
            mutated = true;
            await appendDispatchLog(logsDir, {
              type: 'dispatch_failed',
              team: teamName,
              request_id: request.request_id,
              worker: request.to_worker,
              message_id: request.message_id || null,
              reason: request.last_reason,
            });
            continue;
          }
          request.status = 'notified';
          request.notified_at = nowIso;
          request.last_reason = result.reason;
          if (request.kind === 'mailbox' && request.message_id) {
            await updateMailboxNotified(stateDir, teamName, request.to_worker, request.message_id).catch(() => {});
          }
          processed += 1;
          mutated = true;
          await appendDispatchLog(logsDir, {
            type: 'dispatch_notified',
            team: teamName,
            request_id: request.request_id,
            worker: request.to_worker,
            message_id: request.message_id || null,
            reason: result.reason,
          });
        } else {
          request.status = 'failed';
          request.failed_at = nowIso;
          request.last_reason = result.reason;
          processed += 1;
          failed += 1;
          mutated = true;
          await appendDispatchLog(logsDir, {
            type: 'dispatch_failed',
            team: teamName,
            request_id: request.request_id,
            worker: request.to_worker,
            message_id: request.message_id || null,
            reason: result.reason,
          });
        }
      }

      if (mutated) {
        issueCooldownState.by_issue = issueCooldownByIssue;
        await writeJsonAtomic(issueCooldownStatePath(teamDirPath), issueCooldownState);
        triggerCooldownState.by_trigger = triggerCooldownByKey;
        await writeJsonAtomic(triggerCooldownStatePath(teamDirPath), triggerCooldownState);
        await writeJsonAtomic(requestsPath, requests);
      }
    });
  }

  return { processed, skipped, failed };
}
