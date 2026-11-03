import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Herdr team runtime backend (issue #3241, Phase 2).
 *
 * When the multiplexer setting resolves to 'herdr' (src/config/multiplexer.ts),
 * team workers run as Herdr workspaces/tabs/agents instead of tmux
 * sessions/windows/panes:
 *
 *   - one Herdr workspace per team, labelled `omx-team-<name>` (visible in the
 *     Herdr sidebar, replacing the tmux HUD watch pane)
 *   - one tab per worker, carrying the worker env via `tab create --env`
 *   - one agent per tab, started with `agent start --kind <cli>` and driven
 *     through the semantic agent surface (`agent prompt` / `agent read` /
 *     `agent get`) instead of raw keystrokes
 *
 * Design constraints inherited from the Phase 1 bridge (src/adapt/herdr):
 *   - execFile argv arrays only, never a shell string
 *   - the binary is trust-pinned to HERDR_BIN_PATH when present
 *   - a Herdr failure surfaces as a typed error; callers decide severity
 *
 * The headless server is auto-started on demand (`herdr server` daemonizes the
 * pane runtime), because Herdr CLI commands fail with `server_not_running`
 * otherwise.
 */

export const HERDR_TEAM_WORKSPACE_LABEL_PREFIX = 'omc-team-';
const HERDR_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const HERDR_DEFAULT_EXEC_TIMEOUT_MS = 20_000;
const HERDR_AGENT_START_TIMEOUT_MS = 60_000;
const HERDR_SERVER_START_TIMEOUT_MS = 10_000;
const HERDR_SERVER_POLL_INTERVAL_MS = 250;

export interface HerdrExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  execFn?: typeof execFileAsync;
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(`herdr_${code}: ${message}`);
    this.name = 'HerdrError';
  }
}

/** JSON envelope every Herdr control command answers with. */
export interface HerdrEnvelope {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export function parseHerdrEnvelope(stdout: string): HerdrEnvelope {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new HerdrError('empty_response', 'herdr printed no JSON');
  }
  try {
    const parsed = JSON.parse(trimmed) as HerdrEnvelope;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  throw new HerdrError('invalid_response', 'herdr printed non-JSON output', trimmed.slice(0, 200));
}

function extractErrorDetail(stderr: string): { code: string; message: string } | null {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as HerdrEnvelope;
    if (parsed?.error) {
      return {
        code: parsed.error.code ?? 'error',
        message: parsed.error.message ?? 'herdr command failed',
      };
    }
  } catch {
    // non-JSON stderr
  }
  return { code: 'error', message: trimmed.slice(0, 300) };
}

/**
 * Resolve the Herdr binary. HERDR_BIN_PATH wins when it is an absolute path to
 * an existing file (same trust-pinning as the Phase 1 bridge); otherwise the
 * plain `herdr` name is used and resolved by PATH, mirroring how OMX invokes
 * `tmux` today. Returns null when Herdr cannot be trusted to exist.
 */
export function resolveHerdrBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const pinned = env.HERDR_BIN_PATH?.trim();
  if (pinned && isAbsolute(pinned) && existsSync(pinned)) {
    return pinned;
  }
  return 'herdr';
}

export async function isHerdrBinaryCallable(bin = resolveHerdrBinary()): Promise<boolean> {
  if (bin === null) return false;
  return new Promise((resolvePromise) => {
    execFile(bin, ['--version'], { timeout: 5_000 }, (error) => {
      resolvePromise(error === null);
    });
  });
}

export async function runHerdr(
  args: string[],
  options: HerdrExecOptions = {},
): Promise<HerdrEnvelope> {
  const bin = resolveHerdrBinary(options.env);
  if (bin === null) {
    throw new HerdrError('binary_missing', 'herdr binary not found');
  }
  const exec = options.execFn ?? execFileAsync;
  const { stdout } = await exec(bin, args, {
    timeout: options.timeoutMs ?? HERDR_DEFAULT_EXEC_TIMEOUT_MS,
    env: options.env,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
    const detail = extractErrorDetail(String(error.stderr ?? error.stdout ?? ''));
    const code = error.code === 'ENOENT' ? 'binary_missing' : (detail?.code ?? 'spawn_failed');
    throw new HerdrError(code, detail?.message ?? error.message, String(error.stderr ?? ''));
  });
  const envelope = parseHerdrEnvelope(String(stdout));
  if (envelope.error) {
    throw new HerdrError(
      envelope.error.code ?? 'error',
      envelope.error.message ?? 'herdr command failed',
    );
  }
  return envelope;
}

export async function runHerdrResult<T>(args: string[], options: HerdrExecOptions = {}): Promise<T> {
  const envelope = await runHerdr(args, options);
  return envelope.result as T;
}

/**
 * Run a Herdr command that prints plain text instead of the JSON envelope
 * (pane/agent `read` on the CLI surface). Stderr is still decoded as a JSON
 * error envelope when possible.
 */
export async function runHerdrRaw(args: string[], options: HerdrExecOptions = {}): Promise<string> {
  const bin = resolveHerdrBinary(options.env);
  if (bin === null) {
    throw new HerdrError('binary_missing', 'herdr binary not found');
  }
  const exec = options.execFn ?? execFileAsync;
  const { stdout } = await exec(bin, args, {
    timeout: options.timeoutMs ?? HERDR_DEFAULT_EXEC_TIMEOUT_MS,
    env: options.env,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((error: NodeJS.ErrnoException & { stderr?: string }) => {
    const detail = extractErrorDetail(String(error.stderr ?? ''));
    const code = error.code === 'ENOENT' ? 'binary_missing' : (detail?.code ?? 'spawn_failed');
    throw new HerdrError(code, detail?.message ?? error.message, String(error.stderr ?? ''));
  });
  return String(stdout);
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

export interface HerdrPaneLikeInfo {
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  cwd?: string;
  agent_status?: string;
}

export interface HerdrAgentLikeInfo {
  name?: string;
  agent?: string;
  pane_id?: string;
  agent_status?: string;
  interactive_ready?: boolean;
}

export interface HerdrWorkspaceLikeInfo {
  workspace_id?: string;
  label?: string;
}

/**
 * Ensure a Herdr server owns the socket. When `agent list` answers
 * `server_not_running`, spawn the headless `herdr server` detached and poll
 * until commands answer (workers then outlive the OMX process, which is the
 * Herdr model). Throws herdr_server_start_failed on timeout.
 */
export async function ensureHerdrServer(
  options: { env?: NodeJS.ProcessEnv; bin?: string; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<'running' | 'started'> {
  const env = options.env ?? process.env;
  const bin = options.bin ?? resolveHerdrBinary(env);
  if (bin === null) throw new HerdrError('binary_missing', 'herdr binary not found');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await runHerdr(['agent', 'list'], { env, execFn: options.execFn });
      return 'running';
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== 'server_not_running') throw error;
    }
    if (attempt > 0) break;

    const child = spawn(bin, ['server'], {
      stdio: 'ignore',
      detached: true,
      env,
    });
    child.unref();

    const deadline = Date.now() + HERDR_SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, HERDR_SERVER_POLL_INTERVAL_MS));
      try {
        await runHerdr(['agent', 'list'], { env, execFn: options.execFn });
        return 'started';
      } catch {
        // keep polling until the deadline
      }
    }
  }
  throw new HerdrError('server_start_failed', 'herdr server did not become ready in time');
}

// ---------------------------------------------------------------------------
// Argv builders (pure; unit-tested)
// ---------------------------------------------------------------------------

export function buildWorkspaceCreateArgs(cwd: string, label: string): string[] {
  return ['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'];
}

export function buildTabCreateArgs(
  workspaceId: string,
  cwd: string,
  label: string,
  env?: Record<string, string>,
): string[] {
  const args = ['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label];
  for (const [key, value] of Object.entries(env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('--no-focus');
  return args;
}

export function buildAgentStartArgs(
  name: string,
  kind: string,
  paneId: string,
  agentArgs: readonly string[] = [],
  timeoutMs = HERDR_AGENT_START_TIMEOUT_MS,
): string[] {
  const args = [
    'agent',
    'start',
    name,
    '--kind',
    kind,
    '--pane',
    paneId,
    '--timeout',
    String(timeoutMs),
  ];
  if (agentArgs.length > 0) {
    args.push('--', ...agentArgs);
  }
  return args;
}

export function buildAgentPromptArgs(name: string, text: string): string[] {
  return ['agent', 'prompt', name, text];
}

export function buildAgentGetArgs(name: string): string[] {
  return ['agent', 'get', name];
}

export function buildPaneReadArgs(paneId: string, lines: number): string[] {
  return ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines)];
}

export function buildAgentSendKeysArgs(name: string, key: string): string[] {
  return ['agent', 'send-keys', name, key];
}

export function buildTabCloseArgs(tabId: string): string[] {
  return ['tab', 'close', tabId];
}

export function buildWorkspaceCloseArgs(workspaceId: string): string[] {
  return ['workspace', 'close', workspaceId];
}

/**
 * Herdr agent names must match /^[a-z][a-z0-9_-]{0,31}$/ and be unique among
 * live agents. Build a deterministic, collision-resistant name:
 * `omx-<team[:10]>-<hash4>-w<index>`.
 */
export function buildHerdrAgentName(teamName: string, workerIndex: number): string {
  const sanitized = teamName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 10) || 'team';
  const hash = createHash('sha256').update(teamName).digest('hex').slice(0, 4);
  const name = `omx-${sanitized}-${hash}-w${workerIndex}`;
  if (!HERDR_AGENT_NAME_PATTERN.test(name)) {
    throw new HerdrError('invalid_agent_name', `derived agent name is invalid: ${name}`);
  }
  return name;
}

export function herdrWorkspaceIdFromPaneId(paneId: string): string {
  const separator = paneId.indexOf(':');
  if (separator <= 0 || separator === paneId.length - 1) {
    throw new HerdrError('invalid_pane_id', `not a herdr pane id: ${paneId}`);
  }
  return paneId.slice(0, separator);
}

// ---------------------------------------------------------------------------
// Team engine operations
// ---------------------------------------------------------------------------

export function herdrWorkspaceIdFromSessionTarget(sessionTarget: string): string {
  const prefix = 'herdr:';
  if (!sessionTarget.startsWith(prefix)) {
    throw new HerdrError('invalid_session_target', `not a herdr session target: ${sessionTarget}`);
  }
  const workspaceId = sessionTarget.slice(prefix.length).split(':')[0];
  if (!/^w[0-9a-z]+$/i.test(workspaceId)) {
    throw new HerdrError('invalid_session_target', `not a herdr session target: ${sessionTarget}`);
  }
  return workspaceId;
}

/** Create the team workspace; workers become tabs inside it. */
export async function herdrCreateTeamWorkspace(
  cwd: string,
  label: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<string> {
  await ensureHerdrServer(options);
  const created = await runHerdrResult<{
    workspace?: HerdrWorkspaceLikeInfo;
  }>(buildWorkspaceCreateArgs(cwd, label), { env: options.env, execFn: options.execFn });
  const workspaceId = created?.workspace?.workspace_id;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new HerdrError('missing_workspace_id', 'workspace create did not return workspace_id');
  }
  return workspaceId;
}

/** Split-equivalent: one tab per worker, returning the new root pane id. */
export async function herdrCreateWorkerTab(
  workspaceId: string,
  cwd: string,
  label: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<{ paneId: string; tabId: string }> {
  const tab = await runHerdrResult<{ tab?: { tab_id?: string }; root_pane?: HerdrPaneLikeInfo }>(
    buildTabCreateArgs(workspaceId, cwd, label),
    { env: options.env, execFn: options.execFn },
  );
  const paneId = tab?.root_pane?.pane_id;
  if (typeof paneId !== 'string' || paneId.length === 0) {
    throw new HerdrError('missing_pane_id', 'tab create did not return root_pane.pane_id');
  }
  const tabId = typeof tab?.tab?.tab_id === 'string' ? tab.tab.tab_id : '';
  return { paneId, tabId };
}

/** Deliver a shell command (team start command) into a worker pane. */
export async function herdrRunPaneCommand(
  paneId: string,
  command: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<void> {
  // `pane run` acknowledges admission silently (no JSON envelope), like the
  // other text-surface commands; stderr still decodes typed errors.
  await runHerdrRaw(['pane', 'run', paneId, command], { env: options.env, execFn: options.execFn });
}

/**
 * Submit work to the recognized agent occupying the pane. Agent commands
 * accept the hosting pane id directly; Herdr validates agent identity,
 * honors bracketed paste, and refuses to type into approval dialogs.
 */
export async function herdrSendPrompt(
  paneId: string,
  text: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<void> {
  await runHerdr(['agent', 'prompt', paneId, text], { env: options.env, execFn: options.execFn });
}

/** Send a logical key (esc/enter/ctrl+c) to the agent occupying the pane. */
export async function herdrSendKey(
  paneId: string,
  key: 'enter' | 'esc' | 'escape' | 'ctrl+c',
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<void> {
  await runHerdr(['agent', 'send-keys', paneId, key], { env: options.env, execFn: options.execFn });
}

/** Readiness probe: the recognized agent occupying the pane, or null. */
export async function herdrAgentInfo(
  paneId: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<HerdrAgentLikeInfo | null> {
  const result = await runHerdrResult<{ agent?: HerdrAgentLikeInfo }>(
    ['agent', 'get', paneId],
    { env: options.env, execFn: options.execFn },
  );
  return result?.agent ?? null;
}


/** Submit a task to a worker through the semantic agent surface. */
export async function submitToHerdrWorker(
  agentName: string,
  text: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<void> {
  await runHerdr(buildAgentPromptArgs(agentName, text), { env: options.env, execFn: options.execFn });
}

/** Interrupt the agent turn (Ctrl+C equivalent). */
export async function interruptHerdrWorker(
  agentName: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<void> {
  await runHerdr(buildAgentSendKeysArgs(agentName, 'ctrl+c'), { env: options.env, execFn: options.execFn });
}

/**
 * Capture worker output for the shared pane-text classifiers
 * (`paneLooksReady` / `paneHasActiveTask`, src/scripts/tmux-hook-engine).
 * `recent-unwrapped` matches tmux `capture-pane -J` semantics: soft wraps
 * joined, ANSI stripped.
 */
export async function captureHerdrWorkerPane(
  paneId: string,
  lines = 80,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<string> {
  return runHerdrRaw(buildPaneReadArgs(paneId, lines), {
    env: options.env,
    execFn: options.execFn,
  });
}

/**
 * Worker liveness. `pane get` keeps answering for closed panes (IDs are never
 * reused), so liveness is proven through the live-agent inventory instead:
 * agent names are cleared when the agent exits.
 */
export async function isHerdrWorkerAlive(
  paneId: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<boolean> {
  try {
    const result = await runHerdrResult<{ agents?: HerdrAgentLikeInfo[] }>(
      ['agent', 'list'],
      { env: options.env, execFn: options.execFn },
    );
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    return agents.some((agent) => agent.pane_id === paneId);
  } catch {
    return false;
  }
}

/**
 * Close the worker's pane (and with it the agent). Pane ids are the stable
 * address Herdr hands out (`wN:pM`); tab ids cannot be derived from them, so
 * teardown addresses the pane directly.
 */
export async function teardownHerdrWorker(
  paneId: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<void> {
  await runHerdr(['pane', 'close', paneId], { env: options.env, execFn: options.execFn });
}

/** Close the whole team workspace (session teardown). */
export async function destroyHerdrTeam(
  workspaceId: string,
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<void> {
  await runHerdr(buildWorkspaceCloseArgs(workspaceId), { env: options.env, execFn: options.execFn });
}

/** List teams by workspace label prefix, mirroring listTeamSessions. */
export async function listHerdrTeams(
  options: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] } = {},
): Promise<Array<{ workspaceId: string; teamName: string; label: string }>> {
  const result = await runHerdrResult<{ workspaces?: HerdrWorkspaceLikeInfo[] }>(
    ['workspace', 'list'],
    { env: options.env, execFn: options.execFn },
  );
  const workspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
  return workspaces
    .filter((workspace) => (workspace.label ?? '').startsWith(HERDR_TEAM_WORKSPACE_LABEL_PREFIX))
    .map((workspace) => ({
      workspaceId: workspace.workspace_id ?? '',
      teamName: (workspace.label ?? '').slice(HERDR_TEAM_WORKSPACE_LABEL_PREFIX.length),
      label: workspace.label ?? '',
    }))
    .filter((team) => team.workspaceId.length > 0);
}

/** Close a worker pane (alias of teardownHerdrWorker for the provider arms). */
export const herdrClosePane: (paneId: string, options?: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] }) => Promise<void> = teardownHerdrWorker;

/** Close the whole team workspace (alias of destroyHerdrTeam). */
export const herdrCloseWorkspace: (workspaceId: string, options?: { env?: NodeJS.ProcessEnv; execFn?: HerdrExecOptions['execFn'] }) => Promise<void> = destroyHerdrTeam;
