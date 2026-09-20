// src/team/tmux-session.ts

/**
 * Tmux Session Management for MCP Team Bridge
 *
 * Create, kill, list, and manage tmux sessions for MCP worker bridge daemons.
 * Sessions are named "omc-team-{teamName}-{workerName}".
 */

import { existsSync, statSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, basename, isAbsolute, win32 } from 'path';
import { tmpdir } from 'os';
import { validateTeamName } from './team-name.js';
import { tmuxExec, tmuxExecAsync, tmuxShell, tmuxCmdAsync } from '../cli/tmux-utils.js';
import type { MailboxNotificationTarget, MailboxTargetOwnership } from './mailbox-notification-guard.js';
import type { CliAgentType } from './model-contract.js';
import {
  isValidTeamInstanceId,
  isValidTmuxServerIdentity,
  type TeamInstanceId,
  type TmuxServerIdentity,
} from './types.js';
import {
  currentStrictProcessStartIdentity,
  isValidStrictProcessStartIdentity,
  observeProcessIdentity,
  type ProcessIdentityObservation,
} from './team-owner-epoch.js';
import { paneLineLooksLikeIdlePrompt } from './pane-readiness.js';
import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  cleanupWorkerLaunchTransport,
  isWorkerLaunchAttemptAccepted,
  isWorkerLaunchAttemptCurrent,
  materializeWorkerLaunchTransport,
  prepareWorkerLaunchAttempt,
  retireAndCleanupCurrentWorkerLaunchAttempt,
  revokeWorkerLaunchAttempt,
  type WorkerLaunchAttempt,
  type WorkerLaunchContext,
} from './worker-launch-ack.js';
import { resolveRuntimeCliPath } from './runtime-owner-client.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const execFileAsync = promisify(execFile);

const TMUX_SESSION_PREFIX = 'omc-team';

export type TmuxServerIdentityObservation = 'matching' | 'dead' | 'unknown';

export interface TmuxServerIdentityDependencies {
  tmuxQuery?: (
    args: string[],
    options?: { timeout?: number; stripTmux?: boolean },
  ) => Promise<{ stdout: string; stderr: string }>;
  processIdentity?: (pid: number) => string | null;
  processObservation?: (
    record: Pick<TmuxServerIdentity, 'server_pid' | 'process_started_at'>,
  ) => ProcessIdentityObservation;
}

const defaultTmuxServerIdentityDependencies: Required<TmuxServerIdentityDependencies> = {
  tmuxQuery: (args, options) => tmuxCmdAsync(args, options),
  processIdentity: currentStrictProcessStartIdentity,
  processObservation: (record) => observeProcessIdentity({
    pid: record.server_pid,
    process_started_at: record.process_started_at,
  }),
};

function tmuxArgsForIdentity(identity: TmuxServerIdentity, args: string[]): string[] {
  return ['-S', identity.socket_path, ...args];
}

/** Build the initial empty-server keepalive command queue. */
export function buildDetachedTmuxServerKeepaliveArgs(socketPath: string): string[] {
  if (!isAbsolute(socketPath) && !win32.isAbsolute(socketPath)) {
    throw new Error('tmux_private_socket_path_not_absolute');
  }
  // Passing `;` as its own execFile argument is equivalent to the escaped
  // separator in `tmux start-server \; set-option ...`; both commands are
  // dispatched by the same client/server command queue.
  return [
    '-S', socketPath,
    'start-server', ';',
    'set-option', '-g', 'exit-empty', 'off',
  ];
}

/**
 * Keep private tmux endpoint names below Darwin's Unix-domain socket limit.
 * `/tmp` is deliberately used on Darwin/Linux instead of potentially long
 * TMPDIR values. The random suffix prevents a previous endpoint from being
 * mistaken for this invocation.
 */
export function buildPrivateTmuxSocketPath(): string {
  const socketDirectory = process.platform === 'darwin' || process.platform === 'linux'
    ? '/tmp'
    : tmpdir();
  const socketPath = join(
    socketDirectory,
    `o-${process.pid.toString(36)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.sock`,
  );
  // Darwin's sockaddr_un path budget is 104 bytes including the terminator.
  // Keep a hard byte bound rather than relying on JavaScript code-unit length.
  if (Buffer.byteLength(socketPath, 'utf8') >= 104) {
    throw new Error('tmux_private_socket_path_too_long');
  }
  return socketPath;
}

/**
 * Escape `#` before embedding a value into a tmux command string. Tmux
 * expands `#{...}` before invoking the condition shell, so shell quoting alone
 * is not sufficient for paths or encoded values containing that character.
 */
function tmuxFormatEscape(value: string): string {
  return value.replace(/#/g, '##');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

interface TmuxServerGuardRuntime {
  nodePath: string;
  runtimePath: string;
}

/**
 * Resolve the already-built runtime guard before touching a private tmux
 * endpoint.  The guard is executed from a tmux server shell, so neither PATH
 * lookup nor an unbundled TypeScript entrypoint is acceptable here.
 */
function resolveTmuxServerGuardRuntime(): TmuxServerGuardRuntime {
  let runtimePath: string;
  try {
    runtimePath = resolveRuntimeCliPath();
  } catch {
    throw new Error('tmux_server_guard_runtime_path_unavailable');
  }
  if ((!isAbsolute(runtimePath) && !win32.isAbsolute(runtimePath)) || !isRegularFile(runtimePath)) {
    throw new Error('tmux_server_guard_runtime_path_unavailable');
  }

  const nodePath = process.execPath;
  if ((!isAbsolute(nodePath) && !win32.isAbsolute(nodePath)) || !isRegularFile(nodePath)) {
    throw new Error('tmux_server_guard_node_path_unavailable');
  }
  return { nodePath, runtimePath };
}

function isRegularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function tmuxCommandString(args: string[], formatArgs: readonly string[] = []): string {
  const formats = new Set(formatArgs);
  return args.map(arg => formats.has(arg) ? shellQuote(arg) : shellQuote(tmuxFormatEscape(arg))).join(' ');
}

function parseExactPositivePid(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function parseTmuxServerFields(output: string): { socketPath: string; pid: number } | null {
  const lines = output.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length !== 1) return null;
  const fields = lines[0]!.split('\t');
  if (fields.length !== 2) return null;
  const socketPath = fields[0]!;
  const pid = parseExactPositivePid(fields[1]!);
  if (!socketPath || !isValidTmuxServerIdentity({
    socket_path: socketPath,
    server_pid: pid ?? 0,
    process_started_at: 'probe',
  })) return null;
  return { socketPath, pid: pid! };
}

function buildTmuxServerIdentity(
  socketPath: string,
  pid: number,
  processIdentity: (pid: number) => string | null,
): TmuxServerIdentity | null {
  const processStartedAt = processIdentity(pid);
  if (!processStartedAt || !isValidStrictProcessStartIdentity(processStartedAt)) return null;
  const identity: TmuxServerIdentity = {
    socket_path: socketPath,
    server_pid: pid,
    process_started_at: processStartedAt,
  };
  return isValidTmuxServerIdentity(identity) ? identity : null;
}

function parseTmuxCreationRecord(
  output: string,
  resourceFields: 3 | 4,
  processIdentity: (pid: number) => string | null = currentStrictProcessStartIdentity,
  knownIdentity?: TmuxServerIdentity,
): { resource: string; paneId: string; identity: TmuxServerIdentity } | null {
  const lines = output.split(/\r?\n/).filter(line => line.length > 0);
  const candidates = lines.filter(line => line.split('\t').length === resourceFields);
  if (candidates.length !== 1) return null;
  const fields = candidates[0]!.split('\t');
  const resource = resourceFields === 4 ? fields[0]! : '';
  const paneIndex = resourceFields === 3 ? 0 : 1;
  const paneId = fields[paneIndex]!;
  const socketPath = fields[resourceFields - 2]!;
  const pid = parseExactPositivePid(fields[resourceFields - 1]!);
  if ((resourceFields === 4 && !resource) || !/^%\d+$/.test(paneId) || !pid || !socketPath) return null;
  const identity = knownIdentity
    && knownIdentity.socket_path === socketPath
    && knownIdentity.server_pid === pid
    ? knownIdentity
    : buildTmuxServerIdentity(socketPath, pid, processIdentity);
  if (!identity) return null;
  return { resource, paneId, identity };
}

/**
 * Capture the selected tmux server's endpoint and strict process incarnation.
 *
 * With no endpoint argument the ambient tmux context is queried once. When an
 * endpoint is supplied, every query is explicitly bound to that socket.
 * Failure is represented as `null` (unknown), never as a synthetic identity.
 */
export async function captureTmuxServerIdentity(
  selectedEndpoint?: string,
  dependencies: TmuxServerIdentityDependencies = {},
): Promise<TmuxServerIdentity | null> {
  const deps = { ...defaultTmuxServerIdentityDependencies, ...dependencies };
  if (selectedEndpoint !== undefined
    && (!isValidTmuxServerIdentity({
      socket_path: selectedEndpoint,
      server_pid: 1,
      process_started_at: 'probe',
    }))) {
    return null;
  }
  const args = selectedEndpoint === undefined
    ? ['display-message', '-p', '#{socket_path}\t#{pid}']
    : tmuxArgsForIdentity({
      socket_path: selectedEndpoint,
      server_pid: 1,
      process_started_at: 'probe',
    }, ['display-message', '-p', '#{socket_path}\t#{pid}']);
  try {
    const result = await deps.tmuxQuery(args, selectedEndpoint === undefined ? undefined : {
      timeout: 2_000,
      stripTmux: true,
    });
    if (result.stderr.trim()) return null;
    const fields = parseTmuxServerFields(result.stdout);
    if (!fields || (selectedEndpoint !== undefined && fields.socketPath !== selectedEndpoint)) return null;
    return buildTmuxServerIdentity(fields.socketPath, fields.pid, deps.processIdentity);
  } catch {
    return null;
  }
}

/**
 * Compare one persisted tmux identity with the process and server currently
 * reachable at its captured socket. Only affirmative process evidence can
 * produce `dead`; all probe failures remain `unknown`.
 */
export async function observeTmuxServerIdentity(
  expected: TmuxServerIdentity,
  dependencies: TmuxServerIdentityDependencies = {},
): Promise<TmuxServerIdentityObservation> {
  const deps = { ...defaultTmuxServerIdentityDependencies, ...dependencies };
  if (!isValidTmuxServerIdentity(expected)
    || !isValidStrictProcessStartIdentity(expected.process_started_at)) return 'unknown';

  let processState: ProcessIdentityObservation;
  try {
    processState = deps.processObservation({
      server_pid: expected.server_pid,
      process_started_at: expected.process_started_at,
    });
  } catch {
    return 'unknown';
  }
  if (processState === 'dead') return 'dead';
  if (processState !== 'matching') return 'unknown';

  try {
    const result = await deps.tmuxQuery(
      tmuxArgsForIdentity(expected, ['display-message', '-p', '#{pid}']),
      { timeout: 2_000, stripTmux: true },
    );
    if (result.stderr.trim()) return 'unknown';
    const lines = result.stdout.split(/\r?\n/).filter(line => line.length > 0);
    if (lines.length !== 1) return 'unknown';
    const actualPid = parseExactPositivePid(lines[0]!);
    if (actualPid !== expected.server_pid) return 'unknown';
    const actualStart = deps.processIdentity(actualPid);
    if (!actualStart || actualStart !== expected.process_started_at) return 'unknown';
    return 'matching';
  } catch {
    // A query failure alone cannot prove that the recorded process died.
    return 'unknown';
  }
}

export interface TmuxServerIdentityGuardOptions {
  processIdentity?: (pid: number) => string | null;
}

/**
 * Read-only server-incarnation guard used inside tmux's `if-shell`
 * condition. Returns a process exit status (0 success, 1 fail closed).
 */
export function runTmuxServerIdentityGuard(
  expected: TmuxServerIdentity,
  formattedActualServerPid: string,
  formattedActualSocket?: string,
  options: TmuxServerIdentityGuardOptions = {},
): 0 | 1 {
  if (!isValidTmuxServerIdentity(expected)
    || !isValidStrictProcessStartIdentity(expected.process_started_at)) return 1;
  const actualPid = parseExactPositivePid(formattedActualServerPid);
  if (actualPid !== expected.server_pid) return 1;
  if (formattedActualSocket !== undefined
    && formattedActualSocket.trim() !== expected.socket_path) return 1;
  const processIdentity = options.processIdentity ?? currentStrictProcessStartIdentity;
  let actualStart: string | null;
  try {
    actualStart = processIdentity(actualPid);
  } catch {
    return 1;
  }
  return actualStart === expected.process_started_at ? 0 : 1;
}

function encodeTmuxServerIdentity(identity: TmuxServerIdentity): string {
  return Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url');
}

function tmuxServerGuardCondition(identity: TmuxServerIdentity): string {
  const runtime = resolveTmuxServerGuardRuntime();
  const runtimePath = tmuxFormatEscape(runtime.runtimePath);
  const nodePath = tmuxFormatEscape(runtime.nodePath);
  const envPath = process.platform === 'win32' && !isUnixLikeOnWindows()
    ? 'env'
    : '/usr/bin/env';
  const encodedIdentity = tmuxFormatEscape(encodeTmuxServerIdentity(identity));
  // `#{pid}` is controlled tmux format syntax. All other values are shell
  // quoted after escaping tmux's `#` expansion characters.
  return [
    shellQuote(envPath),
    '-i',
    shellQuote(nodePath),
    shellQuote(runtimePath),
    '--tmux-server-identity-guard',
    shellQuote(encodedIdentity),
    shellQuote('#{pid}'),
    '<',
    shellQuote('/dev/null'),
  ].join(' ');
}

function tmuxGuardedNativeCommand(
  identity: TmuxServerIdentity,
  nativeCommand: string,
): { condition: string; success: string; failure: string; marker: string } {
  const marker = `OMC_TMUX_GUARD_OK_${randomGuardMarker()}`;
  const condition = tmuxServerGuardCondition(identity);
  return {
    condition,
    success: `${nativeCommand}; display-message -p ${shellQuote(marker)}`,
    failure: `display-message -p ${shellQuote(`OMC_TMUX_GUARD_FAIL_${marker}`)}`,
    marker,
  };
}

let guardMarkerCounter = 0;
function randomGuardMarker(): string {
  guardMarkerCounter = (guardMarkerCounter + 1) % 1_000_000;
  return `${process.pid}_${Date.now().toString(36)}_${guardMarkerCounter.toString(36)}`;
}

async function runGuardedNativeTmuxCommand(
  identity: TmuxServerIdentity,
  nativeCommand: string,
): Promise<{ outcome: 'executed' | 'not_executed' | 'unknown'; stdout: string; stderr: string }> {
  if (!isValidTmuxServerIdentity(identity)) return { outcome: 'unknown', stdout: '', stderr: '' };
  const guarded = tmuxGuardedNativeCommand(identity, nativeCommand);
  try {
    const result = await tmuxCmdAsync(
      tmuxArgsForIdentity(identity, [
        'if-shell',
        guarded.condition,
        guarded.success,
        guarded.failure,
      ]),
      { timeout: 5_000, stripTmux: true },
    );
    if (result.stderr.trim()) return { outcome: 'unknown', stdout: result.stdout, stderr: result.stderr };
    const outputLines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const failureMarker = `OMC_TMUX_GUARD_FAIL_${guarded.marker}`;
    if (outputLines.includes(failureMarker)) {
      return { outcome: 'not_executed', stdout: result.stdout, stderr: result.stderr };
    }
    if (outputLines.includes(guarded.marker)) {
      return { outcome: 'executed', stdout: result.stdout, stderr: result.stderr };
    }
    return { outcome: 'unknown', stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      outcome: 'unknown',
      stdout: '',
      stderr: isTmuxServerNotFoundError(error) ? 'tmux_server_unavailable' : redactBoundedDiagnostic(error),
    };
  }
}

function isTmuxServerNotFoundError(error: unknown): boolean {
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown } | null | undefined;
  const text = [value?.stderr, value?.stdout, value?.message]
    .filter((item): item is string => typeof item === 'string')
    .join('\n')
    .toLowerCase();
  return /no server running|failed to connect|can't connect|no such file|connection refused|server exited/.test(text);
}

export type TeamMultiplexerContext = 'tmux' | 'cmux' | 'none';

export function detectTeamMultiplexerContext(
  env: NodeJS.ProcessEnv = process.env,
): TeamMultiplexerContext {
  if (env.TMUX) return 'tmux';
  if (env.CMUX_SURFACE_ID) return 'cmux';
  return 'none';
}

/**
 * True when running on Windows under MSYS2/Git Bash.
 * Tmux panes run bash in this environment, not cmd.exe.
 */
export function isUnixLikeOnWindows(): boolean {
  return process.platform === 'win32' &&
    !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}

export async function applyMainVerticalLayout(
  teamTarget: string,
  options: { required?: boolean; tmuxServerIdentity?: TmuxServerIdentity } = {},
): Promise<void> {
  const identity = options.tmuxServerIdentity;
  if (teamTarget.startsWith('cmux:')) return;
  if (!identity) {
    if (options.required) throw new Error('tmux_server_identity_missing');
    return;
  }
  try {
    const widthArgs = [
      'display-message', '-p', '-t', teamTarget, '#{window_width}',
    ];
    const widthResult = await tmuxCmdAsync(
      tmuxArgsForIdentity(identity, widthArgs),
      { timeout: 2_000, stripTmux: true },
    );
    const width = parseInt(widthResult.stdout.trim(), 10);
    if (!Number.isFinite(width) || width < 40) {
      throw new Error(`team_layout_window_width_invalid:${widthResult.stdout.trim() || 'empty'}`);
    }
    const half = String(Math.floor(width / 2));
    const setArgs = ['set-window-option', '-t', teamTarget, 'main-pane-width', half];
    const result = await runGuardedNativeTmuxCommand(identity, tmuxCommandString(setArgs));
    if (result.outcome !== 'executed') throw new Error('team_layout_server_guard_failed');
  } catch (error) {
    if (options.required || identity) throw error;
    return;
  }

  try {
    const selectArgs = ['select-layout', '-t', teamTarget, 'main-vertical'];
    const result = await runGuardedNativeTmuxCommand(identity, tmuxCommandString(selectArgs));
    if (result.outcome !== 'executed') throw new Error('team_layout_server_guard_failed');
  } catch (error) {
    if (options.required || identity) throw error;
  }
}

async function configureTmuxClipboardAtIdentity(
  identity: TmuxServerIdentity,
  sessionTarget: string,
): Promise<void> {
  const setOption = async (args: string[]) => {
    const result = await runGuardedNativeTmuxCommand(identity, tmuxCommandString(args));
    if (result.outcome !== 'executed') throw new Error('tmux_server_guard_failed');
  };
  await setOption(['set-option', '-t', sessionTarget, 'set-clipboard', 'on']);

  let terminalFeatures = '';
  const result = await tmuxCmdAsync(
    tmuxArgsForIdentity(identity, ['show-options', '-t', sessionTarget, '-v', 'terminal-features']),
    { timeout: 2_000, stripTmux: true },
  );
  if (result.stderr.trim()) throw new Error('tmux_server_observation_failed');
  terminalFeatures = result.stdout;
  if (!hasUniversalClipboardFeature(terminalFeatures)) {
    await setOption(['set-option', '-at', sessionTarget, 'terminal-features', ',*:clipboard']);
  }
}

function hasUniversalClipboardFeature(features: string): boolean {
  return features
    .split(/\r?\n|,/)
    .map(feature => feature.trim())
    .some(feature => feature === '*:clipboard' || feature.startsWith('*:clipboard:'));
}


function isCmuxContext(): boolean {
  return detectTeamMultiplexerContext() === 'cmux';
}

function isCmuxSurfaceTarget(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.trim().startsWith('%');
}

async function cmuxExecAsync(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('cmux', args, { encoding: 'utf-8' });
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? ''),
    stderr: typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? ''),
  };
}

function getCmuxErrorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr?: string }).stderr
      : '';
    return `${error.message}\n${stderr}`.trim();
  }
  return String(error);
}

function isCmuxDialectFailure(error: unknown): boolean {
  const text = getCmuxErrorText(error);
  return /(?:unknown|unrecognized|invalid|unsupported) (?:command|subcommand|option)|no such (?:command|subcommand)|Found argument .*--surface.*wasn't expected|unexpected argument|unexpected option/i.test(text);
}

function redactCmuxFailureMessage(error: unknown, argLists: string[][]): string {
  let message = getCmuxErrorText(error);
  const commandNames = new Set(argLists.map(args => args[0]).filter(Boolean));
  const sensitiveArgs = [...new Set(argLists.flatMap(args => args).flatMap(arg => {
    if (!arg || commandNames.has(arg)) return [];
    const fragments = arg.match(/[A-Za-z0-9_./:@=-]{4,}/g) ?? [];
    return [arg, ...fragments];
  }))].sort((a, b) => b.length - a.length);

  for (const arg of sensitiveArgs) {
    message = message.split(arg).join('[redacted]');
  }

  return message;
}

async function cmuxExecPrimaryWithLegacyFallback(
  primaryArgs: string[],
  legacyArgs: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await cmuxExecAsync(primaryArgs);
  } catch (primaryError) {
    if (!isCmuxDialectFailure(primaryError)) {
      const primaryMessage = redactCmuxFailureMessage(primaryError, [primaryArgs]);
      const error = new Error(
        `cmux command failed for current form: current=${primaryArgs[0] ?? '<unknown>'} (${primaryMessage})`,
      );
      (error as { cause?: unknown }).cause = primaryError;
      throw error;
    }

    try {
      return await cmuxExecAsync(legacyArgs);
    } catch (legacyError) {
      const primaryMessage = redactCmuxFailureMessage(primaryError, [primaryArgs, legacyArgs]);
      const legacyMessage = redactCmuxFailureMessage(legacyError, [primaryArgs, legacyArgs]);
      throw new Error(
        `cmux command failed for both current and legacy forms: current=${primaryArgs[0] ?? '<unknown>'} (${primaryMessage}); ` +
        `legacy=${legacyArgs[0] ?? '<unknown>'} (${legacyMessage})`,
      );
    }
  }
}

function parseCmuxSurfaceId(output: string): string {
  const trimmed = output.trim();
  const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const token = tokens[0] === 'OK' ? tokens[1] : tokens[0];
  if (!token) throw new Error(`Failed to resolve cmux surface id: "${trimmed}"`);
  return token;
}

async function cmuxSplitSurface(targetSurfaceId: string, direction: 'right' | 'down', _cwd: string): Promise<{ stdout: string; stderr: string; paneId: string | null }> {
  const args = ['new-split', direction, '--surface', targetSurfaceId];
  if (process.env.CMUX_WORKSPACE_ID) args.push('--workspace', process.env.CMUX_WORKSPACE_ID);
  const result = await cmuxExecAsync(args);
  let paneId: string | null = null;
  try { paneId = parseCmuxSurfaceId(result.stdout); } catch { /* successful split with unparseable identity */ }
  return { ...result, paneId };
}

async function cmuxSendSurface(surfaceId: string, text: string): Promise<void> {
  // cmux 0.64.x targets a specific surface with the dedicated
  // `send-surface` subcommand. `cmux send --surface ...` is parsed as the
  // focused-surface form plus an unknown option in current cmux builds, which
  // makes worker startup fail after the split/worktree has already been
  // created. The top-level `omc team` catch then prints generic usage and the
  // startup rollback tears the empty worktree down. (#3325)
  await cmuxExecPrimaryWithLegacyFallback(
    ['send-surface', '--surface', surfaceId, text],
    ['send', '--surface', surfaceId, text],
  );
}

function normalizeCmuxKey(key: string): string {
  const normalized = key.trim();
  const lower = normalized.toLowerCase();
  switch (lower) {
    case 'enter':
    case 'return':
    case 'tab':
    case 'escape':
    case 'esc':
    case 'backspace':
    case 'delete':
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return lower === 'return' ? 'enter' : lower === 'esc' ? 'escape' : lower;
    default:
      return normalized;
  }
}

async function cmuxSendSurfaceKey(surfaceId: string, key: string): Promise<void> {
  // See cmuxSendSurface(): targeting a surface uses `send-key-surface`, not a
  // `--surface` option on `send-key`. Key names are lower-case in the cmux CLI
  // reference; normalize common names while leaving advanced chord strings alone.
  const normalizedKey = normalizeCmuxKey(key);
  await cmuxExecPrimaryWithLegacyFallback(
    ['send-key-surface', '--surface', surfaceId, normalizedKey],
    ['send-key', '--surface', surfaceId, key],
  );
}

async function cmuxCaptureSurface(surfaceId: string): Promise<string> {
  const result = await cmuxExecPrimaryWithLegacyFallback(
    ['read-screen', '--surface', surfaceId],
    ['capture-pane', '--surface', surfaceId, '--scrollback'],
  );
  return result.stdout;
}

async function cmuxCloseSurface(surfaceId: string): Promise<void> {
  await cmuxExecAsync(['close-surface', '--surface', surfaceId]);
}

const TMUX_MAILBOX_PANE_ID = /^%\d+$/;
const TMUX_MAILBOX_TARGET = /^[^\s:]+(?::[^\s:]+)?$/;

function exactTmuxPaneMembershipTarget(providerTarget: string): {
  target: string;
  sessionScope: boolean;
} | null {
  // Native tmux IDs are already exact and must not be passed through the
  // name-matching `=` syntax. Keep the accepted ID shapes narrow so an
  // ambiguous `$`/`@` target cannot become a destructive name lookup.
  if (/^\$\d+$/.test(providerTarget)) {
    return { target: providerTarget, sessionScope: true };
  }
  if (/^@\d+$/.test(providerTarget)) {
    return { target: providerTarget, sessionScope: false };
  }
  if (/^[\$@]/.test(providerTarget)) return null;

  // A bare session target must carry the trailing colon. Without a window
  // component, tmux treats the exact target as a pane/window name and rejects
  // it. Session-scoped listing then covers every window in that exact session.
  if (!providerTarget.includes(':')) {
    return { target: `=${providerTarget}:`, sessionScope: true };
  }

  const separator = providerTarget.indexOf(':');
  if (separator <= 0 || separator === providerTarget.length - 1) return null;
  if (providerTarget.indexOf(':', separator + 1) !== -1) return null;
  const sessionName = providerTarget.slice(0, separator);
  const windowName = providerTarget.slice(separator + 1);
  if (
    !sessionName
    || !windowName
    || sessionName.startsWith('=')
    || windowName.startsWith('=')
    || (windowName.startsWith('$') && !/^\$\d+$/.test(windowName))
    || (windowName.startsWith('@') && !/^@\d+$/.test(windowName))
  ) {
    return null;
  }

  const sessionTarget = `=${sessionName}`;
  const windowTarget = /^\d+$/.test(windowName) || /^@\d+$/.test(windowName)
    ? windowName
    : `=${windowName}`;
  return { target: `${sessionTarget}:${windowTarget}`, sessionScope: false };
}

function isExactOpaqueCmuxIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f\s]/.test(value);
}

function parseCmuxResourceIds(output: string, collectionName: 'panes' | 'surfaces'): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return null;
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)[collectionName])
      ? (parsed as Record<string, unknown>)[collectionName] as unknown[]
      : null;
  if (!entries) return null;

  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const id = (entry as Record<string, unknown>).id;
    if (!isExactOpaqueCmuxIdentifier(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

type MailboxOwnershipCommand = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface MailboxTargetOwnershipDependencies {
  tmuxExec: MailboxOwnershipCommand;
  cmuxExec: MailboxOwnershipCommand;
  serverIdentityDependencies?: TmuxServerIdentityDependencies;
}

const defaultMailboxTargetOwnershipDependencies: MailboxTargetOwnershipDependencies = {
  tmuxExec: (args) => tmuxExecAsync(args),
  cmuxExec: cmuxExecAsync,
};

/**
 * Proves that a configured direct-mailbox target still belongs to its exact
 * provider target. This performs read-only provider queries and never touches
 * a candidate pane/surface.
 */
export async function verifyTeamTargetOwnership(
  target: MailboxNotificationTarget,
  dependencies: MailboxTargetOwnershipDependencies = defaultMailboxTargetOwnershipDependencies,
): Promise<MailboxTargetOwnership> {
  const expectedProvider = target.providerTarget.startsWith('cmux:') ? 'cmux' : 'tmux';
  if (target.provider !== expectedProvider) return { kind: 'provider_mismatch' };

  if (target.provider === 'tmux') {
    if (
      !isValidTmuxServerIdentity((target as MailboxNotificationTarget & {
        tmuxServerIdentity?: TmuxServerIdentity;
      }).tmuxServerIdentity)
      ||
      typeof target.providerTarget !== 'string'
      || target.providerTarget.length === 0
      || target.providerTarget !== target.providerTarget.trim()
      || !TMUX_MAILBOX_TARGET.test(target.providerTarget)
      || !TMUX_MAILBOX_PANE_ID.test(target.paneId)
    ) {
      return { kind: 'unavailable' };
    }

    const tmuxServerIdentity = (target as MailboxNotificationTarget & {
      tmuxServerIdentity: TmuxServerIdentity;
    }).tmuxServerIdentity;
    if (await observeTmuxServerIdentity(
      tmuxServerIdentity,
      dependencies.serverIdentityDependencies,
    ) !== 'matching') {
      return { kind: 'unavailable' };
    }

    try {
      const membershipTarget = exactTmuxPaneMembershipTarget(target.providerTarget);
      if (!membershipTarget) return { kind: 'unavailable' };
      const result = await dependencies.tmuxExec(tmuxArgsForIdentity(tmuxServerIdentity, [
        'list-panes',
        ...(membershipTarget.sessionScope ? ['-s'] : []),
        '-t', membershipTarget.target,
        '-F', '#{pane_id}',
      ]));
      if (result.stderr.trim()) return { kind: 'unavailable' };
      if (await observeTmuxServerIdentity(
        tmuxServerIdentity,
        dependencies.serverIdentityDependencies,
      ) !== 'matching') return { kind: 'unavailable' };
      const paneIds: string[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        const paneId = line.trim();
        if (!paneId) continue;
        if (!TMUX_MAILBOX_PANE_ID.test(paneId)) return { kind: 'unavailable' };
        if (!paneIds.includes(paneId)) paneIds.push(paneId);
      }
      if (paneIds.length === 0) return { kind: 'unavailable' };
      return paneIds.includes(target.paneId)
        ? {
            kind: 'owned',
            provider: 'tmux',
            providerTarget: target.providerTarget,
            paneId: target.paneId,
            tmuxServerIdentity: { ...tmuxServerIdentity },
          }
        : { kind: 'foreign' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  const workspace = target.providerTarget.slice('cmux:'.length);
  if (
    !isExactOpaqueCmuxIdentifier(workspace)
    || !isExactOpaqueCmuxIdentifier(target.paneId)
    || TMUX_MAILBOX_PANE_ID.test(target.paneId)
  ) {
    return { kind: 'unavailable' };
  }

  try {
    const panes = parseCmuxResourceIds(
      (await dependencies.cmuxExec(['--json', 'list-panes', '--workspace', workspace])).stdout,
      'panes',
    );
    if (!panes || panes.length === 0) return { kind: 'unavailable' };

    for (const pane of panes) {
      const surfaces = parseCmuxResourceIds(
        (await dependencies.cmuxExec([
          '--json', 'list-pane-surfaces', '--workspace', workspace, '--pane', pane,
        ])).stdout,
        'surfaces',
      );
      if (!surfaces) return { kind: 'unavailable' };
      if (surfaces.includes(target.paneId)) {
        return {
          kind: 'owned',
          provider: 'cmux',
          providerTarget: target.providerTarget,
          paneId: target.paneId,
        };
      }
    }
    return { kind: 'foreign' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export type DirectMailboxEffectResult =
  | { kind: 'not_attempted'; reason: string }
  | { kind: 'confirmed'; transport: 'tmux_send_keys'; reason: 'worker_pane_notified' | 'leader_pane_notified' }
  | { kind: 'attempted_unconfirmed'; transport: 'tmux_send_keys'; reason: 'notification_delivery_uncertain'; cause: 'returned_false' | 'threw' };

export interface DirectMailboxEffectDependencies {
  sendWorker: typeof sendToWorker;
  sendLeader: typeof injectToLeaderPane;
  serverIdentityDependencies?: TmuxServerIdentityDependencies;
}

const defaultDirectMailboxEffectDependencies: DirectMailboxEffectDependencies = {
  sendWorker: sendToWorker,
  sendLeader: injectToLeaderPane,
};

/**
 * Direct-mailbox-only adapter. Once the public boolean transport has been
 * called, a false result or exception is conservatively treated as uncertain.
 */
export async function invokeDirectMailboxEffect(
  target: MailboxNotificationTarget,
  message: string,
  dependencies: DirectMailboxEffectDependencies = defaultDirectMailboxEffectDependencies,
): Promise<DirectMailboxEffectResult> {
  if (!target.paneId || !message) return { kind: 'not_attempted', reason: 'mailbox_target_missing' };
  if (target.provider === 'cmux' && !isCmuxContext()) {
    return { kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' };
  }
  if (target.provider === 'tmux') {
    const tmuxServerIdentity = (target as MailboxNotificationTarget & {
      tmuxServerIdentity?: TmuxServerIdentity;
    }).tmuxServerIdentity;
    if (!isValidTmuxServerIdentity(tmuxServerIdentity)) {
      return { kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' };
    }
    const serverState = await observeTmuxServerIdentity(
      tmuxServerIdentity,
      dependencies.serverIdentityDependencies,
    );
    if (serverState !== 'matching') {
      return { kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' };
    }
    const membership = await verifyTeamTargetOwnership(target, {
      ...defaultMailboxTargetOwnershipDependencies,
      ...(dependencies.serverIdentityDependencies
        ? { serverIdentityDependencies: dependencies.serverIdentityDependencies }
        : {}),
    });
    if (membership.kind !== 'owned') {
      return { kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' };
    }
    const text = target.recipientRole === 'leader'
      ? `[OMC_TMUX_INJECT] ${message}`.slice(0, 200)
      : message;
    try {
      const literal = await runGuardedNativeTmuxCommand(
        tmuxServerIdentity,
        tmuxCommandString(['send-keys', '-t', target.paneId, '-l', '--', text]),
      );
      if (literal.outcome !== 'executed') {
        return literal.outcome === 'not_executed'
          ? { kind: 'not_attempted', reason: 'mailbox_membership_unresolvable' }
          : {
              kind: 'attempted_unconfirmed',
              transport: 'tmux_send_keys',
              reason: 'notification_delivery_uncertain',
              cause: 'returned_false',
            };
      }
      const enter = await runGuardedNativeTmuxCommand(
        tmuxServerIdentity,
        tmuxCommandString(['send-keys', '-t', target.paneId, 'Enter']),
      );
      if (enter.outcome !== 'executed') {
        return {
          kind: 'attempted_unconfirmed',
          transport: 'tmux_send_keys',
          reason: 'notification_delivery_uncertain',
          cause: enter.outcome === 'unknown' ? 'threw' : 'returned_false',
        };
      }
      return {
        kind: 'confirmed',
        transport: 'tmux_send_keys',
        reason: target.recipientRole === 'leader' ? 'leader_pane_notified' : 'worker_pane_notified',
      };
    } catch {
      return {
        kind: 'attempted_unconfirmed',
        transport: 'tmux_send_keys',
        reason: 'notification_delivery_uncertain',
        cause: 'threw',
      };
    }
  }
  try {
    const notified = target.recipientRole === 'leader'
      ? await dependencies.sendLeader(target.providerTarget, target.paneId, message)
      : await dependencies.sendWorker(target.providerTarget, target.paneId, message);
    return notified
      ? {
          kind: 'confirmed',
          transport: 'tmux_send_keys',
          reason: target.recipientRole === 'leader' ? 'leader_pane_notified' : 'worker_pane_notified',
        }
      : {
          kind: 'attempted_unconfirmed',
          transport: 'tmux_send_keys',
          reason: 'notification_delivery_uncertain',
          cause: 'returned_false',
        };
  } catch {
    return {
      kind: 'attempted_unconfirmed',
      transport: 'tmux_send_keys',
      reason: 'notification_delivery_uncertain',
      cause: 'threw',
    };
  }
}

export type TeamSessionMode = 'split-pane' | 'dedicated-window' | 'detached-session';

export interface TeamSession {
  sessionName: string;
  leaderPaneId: string;
  workerPaneIds: string[];
  sessionMode: TeamSessionMode;
  /** Present only for tmux-backed sessions; CMUX must not receive a fake one. */
  tmuxServerIdentity?: TmuxServerIdentity;
}

export interface TeamSessionCreationEvidence {
  provider: 'tmux' | 'cmux';
  operation: string;
  rawOutput: string;
  stderr: string;
  /** Diagnostic only; never treated as a persisted server identity. */
  socketPath?: string;
  tmuxServerIdentity?: TmuxServerIdentity;
}

/**
 * Raised when startup created native resources but identity-bound rollback
 * could not prove that every resource was removed. Callers must retain the
 * pending lifecycle state and use `partialSession` as cleanup evidence; they
 * must not declare the team cleaned from the error message alone.
 * `cleanupStatus` is explicitly set to `verified` only when an enclosing
 * rollback boundary proves removal; absent/unknown status is fail-closed.
 */
export class TeamSessionCreationError extends Error {
  readonly partialSession: TeamSession;
  readonly creationEvidence?: TeamSessionCreationEvidence;
  cleanupStatus: 'verified' | 'unknown' = 'unknown';

  constructor(
    message: string,
    partialSession: TeamSession,
    creationEvidence?: TeamSessionCreationEvidence,
  ) {
    super(message);
    this.name = 'TeamSessionCreationError';
    this.partialSession = {
      ...partialSession,
      workerPaneIds: [...partialSession.workerPaneIds],
      ...(partialSession.tmuxServerIdentity
        ? { tmuxServerIdentity: { ...partialSession.tmuxServerIdentity } }
        : {}),
    };
    if (creationEvidence) {
      this.creationEvidence = {
        ...creationEvidence,
        ...(creationEvidence.socketPath ? { socketPath: creationEvidence.socketPath } : {}),
        ...(creationEvidence.tmuxServerIdentity
          ? { tmuxServerIdentity: { ...creationEvidence.tmuxServerIdentity } }
          : {}),
      };
    }
  }
}

export interface CreateTeamSessionOptions {
  newWindow?: boolean;
}

export interface WorkerPaneConfig {
  teamName: string;
  workerName: string;
  /** Required for owned launches; omitted by legacy inline/non-owned panes. */
  instanceId?: TeamInstanceId;
  envVars: Record<string, string>;
  launchBinary?: string;
  launchArgs?: string[];
  /** @deprecated Prefer launchBinary + launchArgs for safe argv handling */
  launchCmd?: string;
  cwd: string;
  provider?: CliAgentType;
  launchBootstrapPath?: string;
  launchStateCwd?: string;
  launchContext?: WorkerLaunchContext;
  launchAttempt?: WorkerLaunchAttempt;
  /** Captured tmux server binding for owned pane delivery. */
  tmuxServerIdentity?: TmuxServerIdentity;
}

/** Shells known to support the `-lc 'exec "$@"'` invocation pattern. */
const SUPPORTED_POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh']);

export function getDefaultShell(): string {
  if (process.platform === 'win32' && !isUnixLikeOnWindows()) {
    return process.env.COMSPEC || 'cmd.exe';
  }
  const shell = process.env.SHELL || '/bin/bash';
  // Validate that the shell supports our launch script syntax.
  // Unsupported shells (tcsh, csh, etc.) fall back to /bin/sh.
  const name = basename(shell.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');
  if (!SUPPORTED_POSIX_SHELLS.has(name)) {
    return '/bin/sh';
  }
  return shell;
}

/** Shell + rc file pair used for worker pane launch */
export interface WorkerLaunchSpec {
  shell: string;
  rcFile: string | null;
}

const ZSH_CANDIDATES = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'];
const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash'];

function pathEntries(envPath: string | undefined): string[] {
  return (envPath ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function pathCandidateNames(candidatePath: string): string[] {
  const base = basename(candidatePath.replace(/\\/g, '/'));
  const bare = base.replace(/\.(exe|cmd|bat)$/i, '');

  if (process.platform === 'win32') {
    return Array.from(new Set([`${bare}.exe`, `${bare}.cmd`, `${bare}.bat`, bare]));
  }

  return Array.from(new Set([base, bare]));
}

function resolveShellFromPath(candidatePath: string): string | null {
  for (const dir of pathEntries(process.env.PATH)) {
    for (const name of pathCandidateNames(candidatePath)) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** Try a list of shell paths; return first existing path or PATH-discovered binary with its rcFile, or null */
export function resolveShellFromCandidates(paths: string[], rcFile: string): WorkerLaunchSpec | null {
  for (const p of paths) {
    if (existsSync(p)) return { shell: p, rcFile };

    const resolvedFromPath = resolveShellFromPath(p);
    if (resolvedFromPath) return { shell: resolvedFromPath, rcFile };
  }
  return null;
}

/** Check if shellPath is a supported shell (zsh/bash) that exists on disk */
export function resolveSupportedShellAffinity(shellPath?: string): WorkerLaunchSpec | null {
  if (!shellPath) return null;
  const name = basename(shellPath.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');
  if (name !== 'zsh' && name !== 'bash') return null;
  if (!existsSync(shellPath)) return null;
  const home = process.env.HOME ?? '';
  const rcFile = home ? `${home}/.${name}rc` : null;
  return { shell: shellPath, rcFile };
}

/**
 * Resolve the shell and rc file to use for worker pane launch.
 *
 * Priority:
 *   1. MSYS2/Windows → /bin/sh (no rcFile)
 *   2. shellPath (from $SHELL) if zsh or bash and binary exists
 *   3. ZSH candidates
 *   4. BASH candidates
 *   5. Fallback: /bin/sh
 */
export function buildWorkerLaunchSpec(shellPath?: string): WorkerLaunchSpec {
  // MSYS2 / Windows: short-circuit to /bin/sh
  if (isUnixLikeOnWindows()) {
    return { shell: '/bin/sh', rcFile: null };
  }

  // Try user's preferred shell if it's supported (zsh or bash)
  const preferred = resolveSupportedShellAffinity(shellPath);
  if (preferred) return preferred;

  // Try zsh candidates
  const home = process.env.HOME ?? '';
  const zshRc = home ? `${home}/.zshrc` : null;
  const zsh = resolveShellFromCandidates(ZSH_CANDIDATES, zshRc ?? '');
  if (zsh) return { shell: zsh.shell, rcFile: zshRc };

  // Try bash candidates
  const bashRc = home ? `${home}/.bashrc` : null;
  const bash = resolveShellFromCandidates(BASH_CANDIDATES, bashRc ?? '');
  if (bash) return { shell: bash.shell, rcFile: bashRc };

  // Final fallback
  return { shell: '/bin/sh', rcFile: null };
}


function commandFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function redactBoundedDiagnostic(error: unknown, maxLength = 240): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/("--?[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|password|credential|auth)[A-Za-z0-9_-]*"\s*,\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/("[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIALS?)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/(--?[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|password|credential|auth)[A-Za-z0-9_-]*)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1=<redacted>')
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIALS?)=[^\s;]+/gi, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

function logWorkerSpawnDiagnostic(message: string): void {
  process.stderr.write(`[team/tmux-session] ${message}\n`);
}

function paneCurrentCommandLooksReady(command: string): boolean {
  const normalized = basename(command.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return SUPPORTED_POSIX_SHELLS.has(normalized)
    || ['cmd', 'powershell', 'pwsh', 'nu', 'elvish'].includes(normalized);
}

async function getPaneCurrentCommandStatus(
  paneId: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<{ dead: boolean; command: string } | null> {
  try {
    const args = [
      'display-message', '-p', '-t', paneId,
      '#{pane_dead} #{pane_current_command}',
    ];
    const result = await tmuxCmdAsync(
      tmuxServerIdentity ? tmuxArgsForIdentity(tmuxServerIdentity, args) : args,
      { timeout: 1_000, ...(tmuxServerIdentity ? { stripTmux: true } : {}) },
    );
    const status = result.stdout.trim();
    const [dead, ...commandParts] = status.split(/\s+/);
    return { dead: dead === '1', command: commandParts.join(' ') };
  } catch {
    return null;
  }
}

function paneCurrentCommandLooksSubmitted(command: string): boolean {
  return command.length > 0 && !paneCurrentCommandLooksReady(command);
}


export interface WaitForShellReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  tmuxServerIdentity?: TmuxServerIdentity;
}

async function waitForShellReady(paneId: string, opts: WaitForShellReadyOptions = {}): Promise<boolean> {
  if (isCmuxSurfaceTarget(paneId)) return true;
  if (!opts.tmuxServerIdentity) return false;
  if (!isValidTmuxServerIdentity(opts.tmuxServerIdentity)
    || await observeTmuxServerIdentity(opts.tmuxServerIdentity) !== 'matching') return false;
  const envTimeout = Number.parseInt(process.env.OMC_TEAM_SHELL_READY_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
    ? Number(opts.timeoutMs)
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5_000);
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0
    ? Number(opts.pollIntervalMs)
    : 50;

  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const status = await getPaneCurrentCommandStatus(paneId, opts.tmuxServerIdentity);
    if (status) {
      lastStatus = `${status.dead ? '1' : '0'} ${status.command}`.trim();
      if (status.dead) return false;
      if (paneCurrentCommandLooksReady(status.command)) {
        return true;
      }
    }
    await sleep(pollIntervalMs);
  }

  logWorkerSpawnDiagnostic(
    `worker shell readiness timed out pane=${safePaneDiagnosticToken(paneId)} timeoutMs=${timeoutMs} ` +
    `lastStatus=${JSON.stringify(redactBoundedDiagnostic(lastStatus, 128))}`,
  );
  return false;
}

async function verifyWorkerStartCommandDelivered(
  paneId: string,
  startCmd: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<boolean> {
  if (isCmuxSurfaceTarget(paneId)) return true;
  if (!tmuxServerIdentity) return false;
  const expected = normalizeTmuxCapture(startCmd);
  const compactExpected = normalizeTmuxCaptureForDelivery(startCmd);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const captured = await capturePaneAsync(
      paneId,
      { joinWrappedLines: true, tmuxServerIdentity },
    );
    const normalizedCaptured = normalizeTmuxCapture(captured);
    if (normalizedCaptured.includes(expected)) {
      return true;
    }
    if (compactExpected.length > 0 && normalizeTmuxCaptureForDelivery(captured).includes(compactExpected)) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

function resolvePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}


interface WorkerStartSubmitVerificationOptions {
  timeoutMs?: number;
  initialPollIntervalMs?: number;
  maxPollIntervalMs?: number;
  tmuxServerIdentity?: TmuxServerIdentity;
}

async function verifyWorkerStartCommandSubmitted(
  paneId: string,
  startCmd: string,
  opts: WorkerStartSubmitVerificationOptions = {},
): Promise<boolean> {
  if (isCmuxSurfaceTarget(paneId)) return true;
  if (!opts.tmuxServerIdentity) return false;
  const expected = normalizeTmuxCapture(startCmd);
  const compactExpected = normalizeTmuxCaptureForDelivery(startCmd);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
    ? Number(opts.timeoutMs)
    : resolvePositiveIntegerEnv('OMC_TEAM_START_SUBMIT_TIMEOUT_MS', 8_000);
  const maxPollIntervalMs = Number.isFinite(opts.maxPollIntervalMs) && (opts.maxPollIntervalMs ?? 0) > 0
    ? Number(opts.maxPollIntervalMs)
    : 500;
  let pollIntervalMs = Number.isFinite(opts.initialPollIntervalMs) && (opts.initialPollIntervalMs ?? 0) > 0
    ? Number(opts.initialPollIntervalMs)
    : 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const captured = await capturePaneAsync(
      paneId,
      { joinWrappedLines: true, tmuxServerIdentity: opts.tmuxServerIdentity },
    );
    const normalizedCaptured = normalizeTmuxCapture(captured);
    const commandStillBuffered = normalizedCaptured.includes(expected)
      || (compactExpected.length > 0 && normalizeTmuxCaptureForDelivery(captured).includes(compactExpected));
    if (!commandStillBuffered) {
      return true;
    }
    const status = await getPaneCurrentCommandStatus(paneId, opts.tmuxServerIdentity);
    if (status?.dead) {
      return false;
    }
    if (status && paneCurrentCommandLooksSubmitted(status.command)) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
    pollIntervalMs = Math.min(Math.max(pollIntervalMs * 2, pollIntervalMs + 1), maxPollIntervalMs);
  }
  return false;
}

function workerPaneShellCommand(): string[] {
  if (process.platform === 'win32' && !isUnixLikeOnWindows()) {
    return [getDefaultShell()];
  }
  return [];
}

function escapeForCmdSet(value: string): string {
  return value.replace(/(["%])/g, '$1$1');
}

function assertSafeCmdValue(value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid Windows command value: contains CR, LF, or NUL');
}


function shellNameFromPath(shellPath: string): string {
  const shellName = basename(shellPath.replace(/\\/g, '/'));
  return shellName.replace(/\.(exe|cmd|bat)$/i, '');
}
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function assertSafeEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment key: "${key}"`);
  }
}

const DANGEROUS_LAUNCH_BINARY_CHARS = /[;&|`$()<>\n\r\t\0]/;

function isAbsoluteLaunchBinaryPath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function assertSafeLaunchBinary(launchBinary: string): void {
  if (launchBinary.trim().length === 0) {
    throw new Error('Invalid launchBinary: value cannot be empty');
  }
  if (launchBinary !== launchBinary.trim()) {
    throw new Error('Invalid launchBinary: value cannot have leading/trailing whitespace');
  }
  if (DANGEROUS_LAUNCH_BINARY_CHARS.test(launchBinary)) {
    throw new Error('Invalid launchBinary: contains dangerous shell metacharacters');
  }
  if (/\s/.test(launchBinary) && !isAbsoluteLaunchBinaryPath(launchBinary)) {
    throw new Error('Invalid launchBinary: paths with spaces must be absolute');
  }
}

function getLaunchWords(config: WorkerPaneConfig): string[] {
  if (config.launchBinary) {
    assertSafeLaunchBinary(config.launchBinary);
    return [config.launchBinary, ...(config.launchArgs ?? [])];
  }
  if (config.launchCmd) {
    throw new Error(
      'launchCmd is deprecated and has been removed for security reasons. ' +
      'Use launchBinary + launchArgs instead.'
    );
  }
  throw new Error('Missing worker launch command. Provide launchBinary or launchCmd.');
}

export function buildWorkerStartCommand(config: WorkerPaneConfig): string {
  const shell = getDefaultShell();
  const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
  const providerLaunchWords = getLaunchWords(config);
  const launchWords = config.launchAttempt
    ? [process.execPath, config.launchAttempt.runtimeCliPath, '--worker-launch']
    : providerLaunchWords;
  const envVars = config.launchAttempt
    ? {
        ...config.envVars,
        // Supervised launches carry the attempt-owned bootstrap descriptor by
        // path (never inline): secrets stay out of the process list and tmux
        // scrollback, and the delivered command stays small. The runtime CLI
        // validates and consumes the descriptor before running the provider.
        OMC_WORKER_LAUNCH_SPEC_FILE: config.launchAttempt.bootstrapDescriptorPath,
      }
    : config.envVars;
  const shouldSourceRc = process.env.OMC_TEAM_NO_RC !== '1';

  if (process.platform === 'win32' && !isUnixLikeOnWindows()) {
    const windowsEnvVars = { ...envVars };
    if (windowsEnvVars.OMC_WORKER_LAUNCH_SPEC) {
      windowsEnvVars.OMC_WORKER_LAUNCH_SPEC_B64 = Buffer.from(windowsEnvVars.OMC_WORKER_LAUNCH_SPEC, 'utf8').toString('base64');
      delete windowsEnvVars.OMC_WORKER_LAUNCH_SPEC;
    }
    if (windowsEnvVars.OMC_RECOVERY_GATE_SPEC) {
      windowsEnvVars.OMC_RECOVERY_GATE_SPEC_B64 = Buffer.from(windowsEnvVars.OMC_RECOVERY_GATE_SPEC, 'utf8').toString('base64');
      delete windowsEnvVars.OMC_RECOVERY_GATE_SPEC;
    }
    const envPrefix = Object.entries(windowsEnvVars)
      .map(([key, value]) => {
        assertSafeEnvKey(key);
        assertSafeCmdValue(value);
        return `set "${key}=${escapeForCmdSet(value)}"`;
      })
      .join(' && ');
    const launch = launchWords.map(part => {
      assertSafeCmdValue(part);
      return `"${escapeForCmdSet(part)}"`;
    }).join(' ');
    const cmdBody = envPrefix ? `${envPrefix} && ${launch}` : launch;
    return `${shell} /d /s /c "${cmdBody}" & exit /b`;
  }

  const envAssignments = Object.entries(envVars).map(([key, value]) => {
    assertSafeEnvKey(key);
    return `${key}=${shellEscape(value)}`;
  });
  const shellName = shellNameFromPath(shell) || 'bash';
  const isFish = shellName === 'fish';
  const execArgsCommand = isFish ? 'exec $argv' : 'exec "$@"';
  let rcFile = (launchSpec.shell === shell ? launchSpec.rcFile : null) ?? '';
  if (!rcFile && process.env.HOME) {
    rcFile = isFish
      ? `${process.env.HOME}/.config/fish/config.fish`
      : `${process.env.HOME}/.${shellName}rc`;
  }
  const script = isFish
    ? (shouldSourceRc && rcFile
        ? `test -f ${shellEscape(rcFile)}; and source ${shellEscape(rcFile)}; ${execArgsCommand}`
        : execArgsCommand)
    : (shouldSourceRc && rcFile
        ? `[ -f ${shellEscape(rcFile)} ] && . ${shellEscape(rcFile)}; ${execArgsCommand}`
        : execArgsCommand);
  const shellFlags = isFish ? ['-l', '-c'] : ['-lc'];
  return [
    shellEscape('env'),
    ...envAssignments,
    ...[shell, ...shellFlags, script, '--', ...launchWords].map(shellEscape),
  ].join(' ');
}

/** Validate tmux is available. Throws with install instructions if not. */
export function validateTmux(hasTmuxContext = false): void {
  if (hasTmuxContext) {
    return;
  }
  try {
    tmuxShell('-V', { stripTmux: true, timeout: 5000, stdio: 'pipe' });
  } catch {
    throw new Error(
      'tmux is not available. Install it:\n' +
      '  macOS: brew install tmux\n' +
      '  Ubuntu/Debian: sudo apt-get install tmux\n' +
      '  Fedora: sudo dnf install tmux\n' +
      '  Arch: sudo pacman -S tmux\n' +
      '  Windows: winget install psmux'
    );
  }
}

/** Sanitize name to prevent tmux command injection (alphanum + hyphen only) */
export function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9-]/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid name: "${name}" contains no valid characters (alphanumeric or hyphen)`);
  }
  if (sanitized.length < 2) {
    throw new Error(`Invalid name: "${name}" too short after sanitization (minimum 2 characters)`);
  }
  // Truncate to safe length for tmux session names
  return sanitized.slice(0, 50);
}

/** Build session name: "omc-team-{teamName}-{workerName}" */
export function sessionName(teamName: string, workerName: string): string {
  return `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${sanitizeName(workerName)}`;
}

/** @deprecated Use isWorkerAlive() with pane ID instead */
/** Check if a session exists */
export function isSessionAlive(teamName: string, workerName: string): boolean {
  const name = sessionName(teamName, workerName);
  try {
    tmuxExec(['has-session', '-t', name], { stripTmux: true, stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** List all active worker sessions for a team */
export function listActiveSessions(teamName: string): string[] {
  const prefix = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-`;
  try {
    // Use shell execution for format strings containing #{} to prevent
    // MSYS2/Git Bash from stripping curly braces in execFileSync args.
    // All arguments here are hardcoded constants, not user input.
    const output = tmuxShell("list-sessions -F '#{session_name}'", {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim().split('\n')
      .filter(s => s.startsWith(prefix))
      .map(s => s.slice(prefix.length));
  } catch {
    return [];
  }
}

/**
 * Create a tmux team topology for a team leader/worker layout.
 *
 * When running inside a classic tmux session, creates splits in the CURRENT
 * window so panes appear immediately in the user's view. When options.newWindow
 * is true, creates a detached dedicated tmux window first and then splits worker
 * panes there.
 *
 * When running inside cmux (CMUX_SURFACE_ID without TMUX), creates native
 * cmux splits from the current surface. When running in a plain terminal, falls
 * back to a detached tmux session. Returns sessionName in "session:window" form
 * for tmux and "cmux:<workspace>" form for cmux.
 *
 * Layout: leader pane on the left, worker panes stacked vertically on the right.
 * IMPORTANT: Uses pane IDs (%N format) not pane indices for stable targeting.
 */
/**
 * Split a new worker pane off `splitTarget`, honoring the active multiplexer.
 *
 * Under cmux a worker MUST be a native cmux surface (UUID), not a tmux pane id
 * (`%N`). Otherwise spawnWorkerInPane()/waitForShellReady() classify the worker
 * as a tmux pane, poll tmux for shell readiness, and time out after 5s with
 * `worker_start_shell_not_ready` — abandoning the worker's git worktree.
 * createTeamSession() already branches this way for panes created up front; the
 * on-demand worker spawns in both team runtimes must do the same. (#3267)
 */
export interface WorkerPaneSplitEvidence {
  commandSucceeded: boolean;
  provider: 'tmux' | 'cmux';
  splitTarget: string;
  direction: 'right' | 'down';
  rawOutput: string;
  stderr: string;
  paneId: string | null;
  /** Present only when the split was created on tmux. */
  tmuxServerIdentity?: TmuxServerIdentity;
}

export interface WorkerPaneOwnership {
  provider: WorkerPaneSplitEvidence['provider'];
  providerTarget: string;
  paneId: string;
  splitTarget: string;
  leaderPaneId: string;
  reservedPaneIds: readonly string[];
  source: 'split' | 'adopted';
  /** Required for tmux ownership; absent for CMUX surfaces. */
  tmuxServerIdentity?: TmuxServerIdentity;
}

export type WorkerPaneOwnershipResult =
  | { ok: true; ownership: WorkerPaneOwnership }
  | { ok: false; reason: 'split_failed' | 'pane_id_missing' | 'pane_id_malformed' | 'leader_alias' | 'split_target_alias' | 'reserved_worker_alias' | 'pane_foreign' | 'pane_membership_unavailable' | 'tmux_server_identity_missing' | 'tmux_server_identity_mismatch' | 'tmux_server_identity_unknown' };

export interface StartupPaneContext {
  ownership: WorkerPaneOwnership;
  attempt: WorkerLaunchAttempt;
  provider: CliAgentType;
}

function paneIdentityIsProviderNative(provider: WorkerPaneSplitEvidence['provider'], paneId: string): boolean {
  if (provider === 'tmux') return /^%\d+$/.test(paneId);
  return paneId.length <= 256 && !paneId.startsWith('%') && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(paneId);
}

function sameTmuxServerIdentity(
  left: TmuxServerIdentity | undefined,
  right: TmuxServerIdentity | undefined,
): boolean {
  return Boolean(left && right
    && left.socket_path === right.socket_path
    && left.server_pid === right.server_pid
    && left.process_started_at === right.process_started_at);
}

export function proveWorkerPaneOwnership(
  evidence: WorkerPaneSplitEvidence,
  constraints: {
    providerTarget: string;
    leaderPaneId: string;
    reservedPaneIds: readonly string[];
    requireNewFromSplitTarget?: boolean;
    tmuxServerIdentity?: TmuxServerIdentity;
  },
): WorkerPaneOwnershipResult {
  if (!evidence.commandSucceeded) return { ok: false, reason: 'split_failed' };
  if (evidence.provider === 'tmux' && !isValidTmuxServerIdentity(evidence.tmuxServerIdentity)) {
    return { ok: false, reason: 'tmux_server_identity_missing' };
  }
  if (evidence.provider === 'tmux' && constraints.tmuxServerIdentity
    && !sameTmuxServerIdentity(evidence.tmuxServerIdentity, constraints.tmuxServerIdentity)) {
    return { ok: false, reason: 'tmux_server_identity_mismatch' };
  }
  if (!evidence.paneId) return { ok: false, reason: 'pane_id_missing' };
  if (!paneIdentityIsProviderNative(evidence.provider, evidence.paneId)) return { ok: false, reason: 'pane_id_malformed' };
  if (evidence.paneId === constraints.leaderPaneId) return { ok: false, reason: 'leader_alias' };
  if (constraints.requireNewFromSplitTarget !== false && evidence.paneId === evidence.splitTarget) {
    return { ok: false, reason: 'split_target_alias' };
  }
  if (constraints.reservedPaneIds.includes(evidence.paneId)) return { ok: false, reason: 'reserved_worker_alias' };
  return {
    ok: true,
    ownership: {
      provider: evidence.provider,
      providerTarget: constraints.providerTarget,
      paneId: evidence.paneId,
      splitTarget: evidence.splitTarget,
      leaderPaneId: constraints.leaderPaneId,
      reservedPaneIds: [...constraints.reservedPaneIds],
      source: 'split',
      ...(evidence.provider === 'tmux' && evidence.tmuxServerIdentity
        ? { tmuxServerIdentity: { ...evidence.tmuxServerIdentity } }
        : {}),
    },
  };
}

export async function adoptWorkerPaneOwnership(input: {
  provider: WorkerPaneSplitEvidence['provider'];
  providerTarget: string;
  paneId: string;
  leaderPaneId: string;
  reservedPaneIds: readonly string[];
  dependencies?: MailboxTargetOwnershipDependencies;
  tmuxServerIdentity?: TmuxServerIdentity;
  serverIdentityDependencies?: TmuxServerIdentityDependencies;
}): Promise<WorkerPaneOwnershipResult> {
  if (input.provider === 'tmux' && !isValidTmuxServerIdentity(input.tmuxServerIdentity)) {
    return { ok: false, reason: 'tmux_server_identity_missing' };
  }
  if (input.provider === 'tmux') {
    const serverState = await observeTmuxServerIdentity(
      input.tmuxServerIdentity!,
      input.serverIdentityDependencies,
    );
    if (serverState !== 'matching') {
      return { ok: false, reason: 'tmux_server_identity_unknown' };
    }
  }
  const proved = proveWorkerPaneOwnership({
    commandSucceeded: true,
    provider: input.provider,
    splitTarget: '',
    direction: 'right',
    rawOutput: '',
    stderr: '',
    paneId: input.paneId,
    ...(input.provider === 'tmux' ? { tmuxServerIdentity: input.tmuxServerIdentity } : {}),
  }, {
    providerTarget: input.providerTarget,
    leaderPaneId: input.leaderPaneId,
    reservedPaneIds: input.reservedPaneIds,
    requireNewFromSplitTarget: false,
    ...(input.provider === 'tmux' ? { tmuxServerIdentity: input.tmuxServerIdentity } : {}),
  });
  if (!proved.ok) return proved;
  const membershipDependencies = input.dependencies
    ?? defaultMailboxTargetOwnershipDependencies;
  const dependenciesWithIdentityProbe = input.serverIdentityDependencies
    ? {
        ...membershipDependencies,
        serverIdentityDependencies: input.serverIdentityDependencies,
      }
    : membershipDependencies;
  const membership = await verifyTeamTargetOwnership({
    provider: input.provider,
    providerTarget: input.providerTarget,
    recipient: 'worker',
    recipientRole: 'worker',
    paneId: input.paneId,
    ...(input.provider === 'tmux'
      ? { tmuxServerIdentity: input.tmuxServerIdentity }
      : {}),
  } as MailboxNotificationTarget, dependenciesWithIdentityProbe);
  if (membership.kind === 'foreign') return { ok: false, reason: 'pane_foreign' };
  if (membership.kind !== 'owned') return { ok: false, reason: 'pane_membership_unavailable' };
  return {
    ok: true,
    ownership: { ...proved.ownership, source: 'adopted' },
  };
}

export async function workerPaneBelongsToProviderTarget(input: {
  provider: WorkerPaneSplitEvidence['provider'];
  providerTarget: string;
  paneId: string;
  tmuxServerIdentity?: TmuxServerIdentity;
  dependencies?: MailboxTargetOwnershipDependencies;
}, dependencies: MailboxTargetOwnershipDependencies = input.dependencies ?? defaultMailboxTargetOwnershipDependencies): Promise<boolean> {
  const membership = await verifyTeamTargetOwnership({
    provider: input.provider,
    providerTarget: input.providerTarget,
    recipient: 'worker',
    recipientRole: 'worker',
    paneId: input.paneId,
    ...(input.provider === 'tmux'
      ? { tmuxServerIdentity: input.tmuxServerIdentity }
      : {}),
  } as MailboxNotificationTarget, dependencies);
  return membership.kind === 'owned';
}

/** Owned variant of pane membership; tmux queries never reconnect by name. */
export async function workerPaneBelongsToOwnedProviderTarget(input: {
  provider: WorkerPaneSplitEvidence['provider'];
  providerTarget: string;
  paneId: string;
  tmuxServerIdentity?: TmuxServerIdentity;
  dependencies?: MailboxTargetOwnershipDependencies;
  serverIdentityDependencies?: TmuxServerIdentityDependencies;
}): Promise<boolean> {
  if (input.provider !== 'tmux') return workerPaneBelongsToProviderTarget(input);
  if (!isValidTmuxServerIdentity(input.tmuxServerIdentity)) return false;
  if (await observeTmuxServerIdentity(input.tmuxServerIdentity, input.serverIdentityDependencies) !== 'matching') {
    return false;
  }
  const base = input.dependencies ?? defaultMailboxTargetOwnershipDependencies;
  const dependencies = input.serverIdentityDependencies
    ? { ...base, serverIdentityDependencies: input.serverIdentityDependencies }
    : base;
  return workerPaneBelongsToProviderTarget(input, dependencies);
}

export async function splitTeamWorkerPaneWithEvidence(
  splitTarget: string,
  direction: 'right' | 'down',
  cwd: string,
  provider: WorkerPaneSplitEvidence['provider'] = isCmuxContext() ? 'cmux' : 'tmux',
  tmuxServerIdentity?: TmuxServerIdentity,
  serverIdentityDependencies?: TmuxServerIdentityDependencies,
): Promise<WorkerPaneSplitEvidence> {
  try {
    if (provider === 'cmux') {
      const splitResult = await cmuxSplitSurface(splitTarget, direction, cwd);
      return { commandSucceeded: true, provider, splitTarget, direction, rawOutput: splitResult.stdout,
        stderr: splitResult.stderr, paneId: splitResult.paneId };
    }
    // Extending an existing team must carry its persisted server binding.
    // Never recapture the ambient/default server here: after a restart that
    // could silently bind the split to an unrelated incarnation.
    const identity = tmuxServerIdentity;
    if (!identity) {
      return {
        commandSucceeded: false,
        provider,
        splitTarget,
        direction,
        rawOutput: '',
        stderr: 'tmux_server_identity_unknown',
        paneId: null,
      };
    }
    const state = await observeTmuxServerIdentity(identity, serverIdentityDependencies);
    if (state !== 'matching') {
      return {
        commandSucceeded: false,
        provider,
        splitTarget,
        direction,
        rawOutput: '',
        stderr: `tmux_server_identity_${state}`,
        paneId: null,
        tmuxServerIdentity: identity,
      };
    }
    const splitType = direction === 'right' ? '-h' : '-v';
    const splitArgs = [
      'split-window', splitType, '-t', splitTarget,
      '-d', '-P', '-F', '#{pane_id}\t#{socket_path}\t#{pid}',
      '-c', cwd,
      ...workerPaneShellCommand(),
    ];
    const splitResult = await runGuardedNativeTmuxCommand(
      identity,
      tmuxCommandString(splitArgs, ['#{pane_id}\t#{socket_path}\t#{pid}']),
    );
    const parsed = splitResult.outcome === 'executed'
      ? parseTmuxCreationRecord(
        splitResult.stdout,
        3,
        serverIdentityDependencies?.processIdentity ?? currentStrictProcessStartIdentity,
        identity,
      )
      : null;
    const associatedIdentity = parsed?.identity;
    const identityMatches = Boolean(associatedIdentity && sameTmuxServerIdentity(associatedIdentity, identity));
    const revalidated = identityMatches
      && await observeTmuxServerIdentity(identity, serverIdentityDependencies) === 'matching';
    return {
      commandSucceeded: splitResult.outcome === 'executed' && revalidated,
      provider,
      splitTarget,
      direction,
      rawOutput: splitResult.stdout,
      stderr: splitResult.stderr,
      paneId: revalidated ? parsed!.paneId : null,
      tmuxServerIdentity: revalidated ? { ...identity } : undefined,
    };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return { commandSucceeded: false, provider, splitTarget, direction,
      rawOutput: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr
        : typeof failure.message === 'string' ? failure.message : String(error),
      paneId: null };
  }
}

export async function splitTeamWorkerPane(
  splitTarget: string,
  direction: 'right' | 'down',
  cwd: string,
): Promise<string | null> {
  return (await splitTeamWorkerPaneWithEvidence(splitTarget, direction, cwd)).paneId;
}

export async function createTeamSession(
  teamName: string,
  workerCount: number,
  cwd: string,
  options: CreateTeamSessionOptions = {},
): Promise<TeamSession> {
  const multiplexerContext = detectTeamMultiplexerContext();
  const inTmux = multiplexerContext === 'tmux';
  const inCmux = multiplexerContext === 'cmux';
  const useDedicatedWindow = Boolean(options.newWindow && inTmux);
  if (multiplexerContext === 'none') {
    validateTmux();
  }
  // Every tmux-backed creation requires strict process-incarnation support
  // before it can touch a server. Native-unavailable platforms must not leave
  // an empty private server held without an ownership token. CMUX has its own
  // provider identity and is intentionally excluded.
  if (!inCmux && !currentStrictProcessStartIdentity()) {
    throw new Error('tmux_server_identity_probe_unavailable');
  }
  let tmuxServerIdentity: TmuxServerIdentity | undefined;
  let freshDetachedServerIdentity: TmuxServerIdentity | undefined;
  let freshDetachedServerStarted = false;
  let freshSocketPathForEvidence: string | undefined;
  let detachedCreationKnown = false;
  let createdDetachedSession = false;
  let createdDedicatedWindow = false;
  if (inTmux) {
    tmuxServerIdentity = await captureTmuxServerIdentity() ?? undefined;
    if (!tmuxServerIdentity) throw new Error('tmux_server_identity_unavailable');
  }

  // Prefer the invoking pane from environment to avoid focus races when users
  // switch tmux windows during startup (issue #966).
  const envPaneIdRaw = (process.env.TMUX_PANE ?? '').trim();
  const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : '';
  let sessionAndWindow = '';
  let leaderPaneId = envPaneId;
  let sessionMode: TeamSessionMode = inTmux ? 'split-pane' : 'detached-session';
  const workerPaneIds: string[] = [];
  let untrackedProviderAllocation = false;

  const partialCreationSession = (
    name: string = sessionAndWindow,
    mode: TeamSessionMode = sessionMode,
  ): TeamSession => ({
    sessionName: name || (inCmux ? 'cmux:unknown' : ''),
    leaderPaneId,
    workerPaneIds: [...workerPaneIds],
    sessionMode: mode,
    ...(tmuxServerIdentity
      ? { tmuxServerIdentity: { ...tmuxServerIdentity } }
      : {}),
  });

  if (inCmux) {
    const cmuxLeaderSurface = (process.env.CMUX_SURFACE_ID ?? '').trim();
    if (!cmuxLeaderSurface) {
      throw new Error('CMUX_SURFACE_ID is required to create a cmux team session');
    }
    sessionAndWindow = `cmux:${process.env.CMUX_WORKSPACE_ID || 'workspace'}`;
    leaderPaneId = cmuxLeaderSurface;
    sessionMode = 'split-pane';
  } else if (!inTmux) {
    // A detached invocation may still find a default tmux server even when
    // TMUX is unset. Capture that server before mutating it.
    const existingDetachedIdentity = await captureTmuxServerIdentity() ?? undefined;
    const detachedSessionName = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${Date.now().toString(36)}`;
    const partialDetachedSession = (): TeamSession => ({
      sessionName: sessionAndWindow || `${detachedSessionName}:0`,
      leaderPaneId,
      workerPaneIds: [],
      sessionMode: 'detached-session',
      ...(tmuxServerIdentity
        ? { tmuxServerIdentity: { ...tmuxServerIdentity } }
        : {}),
    });
    const detachedArgs = [
      'new-session', '-d', '-P', '-F', '#S:0\t#{pane_id}\t#{socket_path}\t#{pid}',
      '-s', detachedSessionName,
      '-c', cwd,
      ...workerPaneShellCommand(),
    ];
    const cleanupFreshDetachedServer = async (): Promise<boolean> => {
      if (!freshDetachedServerIdentity) return false;
      const result = await runGuardedNativeTmuxCommand(freshDetachedServerIdentity, 'kill-server')
        .catch(() => ({ outcome: 'unknown' as const }));
      if (result.outcome === 'executed') return true;
      return await observeTmuxServerIdentity(freshDetachedServerIdentity) === 'dead';
    };
    const cleanupDetachedSession = async (): Promise<boolean> => {
      if (freshDetachedServerIdentity) return cleanupFreshDetachedServer();
      // An existing server cannot be cleaned by name until the creating
      // command itself returned a valid association. Unknown/false command
      // results must preserve the existing server and retain evidence.
      if (!existingDetachedIdentity || !detachedCreationKnown) return false;
      return await killTeamSession(
        detachedSessionName,
        undefined,
        undefined,
        {
          sessionMode: 'detached-session',
          tmuxServerIdentity: existingDetachedIdentity,
        },
      ).catch(() => false);
    };
    let detachedResult: {
      outcome: 'executed' | 'not_executed' | 'unknown';
      stdout: string;
      stderr: string;
    };
    if (existingDetachedIdentity) {
      tmuxServerIdentity = existingDetachedIdentity;
      try {
        detachedResult = await runGuardedNativeTmuxCommand(
          existingDetachedIdentity,
          tmuxCommandString(detachedArgs, ['#S:0\t#{pane_id}\t#{socket_path}\t#{pid}']),
        );
      } catch (error) {
        const cleaned = await cleanupDetachedSession();
        if (!cleaned) {
          throw new TeamSessionCreationError(
            `tmux_creation_cleanup_unverified:${error instanceof Error ? error.message : String(error)}`,
            partialDetachedSession(),
          );
        }
        throw error;
      }
    } else {
      // Validate guard execution before starting a private server. This must
      // happen before the keepalive queue because a missing source-runtime
      // path would otherwise leave an empty server held with exit-empty off.
      resolveTmuxServerGuardRuntime();
      // Probe availability is part of the creation contract. If the native
      // process-incarnation helper cannot produce strict evidence on this
      // host, do not start an empty server that could never be owned.
      // `start-server` exits immediately when no session keeps the server
      // alive (`exit-empty`). Keep the empty server alive within the initial
      // command queue, capture its strict identity, then guard the actual
      // resource creation against that identity.
      //
      // Darwin limits Unix socket paths to a small fixed budget. Do not append
      // the team name to the caller's often-long TMPDIR; use a short private
      // path and retain enough entropy to avoid endpoint reuse.
      const freshSocketPath = buildPrivateTmuxSocketPath();
      freshSocketPathForEvidence = freshSocketPath;
      try {
        freshDetachedServerStarted = true;
        const keepalive = await tmuxExecAsync(
          buildDetachedTmuxServerKeepaliveArgs(freshSocketPath),
          { stripTmux: true, timeout: 5_000 },
        );
        if (keepalive.stderr.trim()) {
          throw new Error(`Failed to hold detached tmux server: "${redactBoundedDiagnostic(keepalive.stderr)}"`);
        }
        tmuxServerIdentity = await captureTmuxServerIdentity(freshSocketPath) ?? undefined;
        if (!tmuxServerIdentity) {
          throw new Error('tmux_server_identity_unavailable');
        }
        freshDetachedServerIdentity = tmuxServerIdentity;
        detachedResult = await runGuardedNativeTmuxCommand(
          tmuxServerIdentity,
          tmuxCommandString(detachedArgs, ['#S:0\t#{pane_id}\t#{socket_path}\t#{pid}']),
        );
      } catch (error) {
        const cleaned = await cleanupDetachedSession();
        if (!cleaned && freshDetachedServerStarted) {
          throw new TeamSessionCreationError(
            `tmux_creation_cleanup_unverified:${error instanceof Error ? error.message : String(error)}`,
            partialDetachedSession(),
            {
              provider: 'tmux',
              operation: 'start-server',
              rawOutput: '',
              stderr: error instanceof Error ? error.message : String(error),
              socketPath: freshSocketPathForEvidence,
              ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
            },
          );
        }
        throw error;
      }
    }
    if (detachedResult.outcome !== 'executed' || detachedResult.stderr.trim()) {
      const cleaned = await cleanupDetachedSession();
      if (!cleaned) {
        throw new TeamSessionCreationError(
          'tmux_creation_cleanup_unverified',
          partialDetachedSession(),
          {
            provider: 'tmux',
            operation: 'new-session',
            rawOutput: detachedResult.stdout,
            stderr: detachedResult.stderr,
            ...(freshSocketPathForEvidence ? { socketPath: freshSocketPathForEvidence } : {}),
            ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
          },
        );
      }
      throw new Error(`Failed to create detached tmux session: "${detachedResult.stdout.trim()}"`);
    }
    const detachedRecord = parseTmuxCreationRecord(
      detachedResult.stdout,
      4,
      currentStrictProcessStartIdentity,
      tmuxServerIdentity,
    );
    if (!detachedRecord
      || (existingDetachedIdentity && !sameTmuxServerIdentity(detachedRecord.identity, existingDetachedIdentity))) {
      const cleaned = await cleanupDetachedSession();
      if (!cleaned) {
        throw new TeamSessionCreationError(
          'tmux_creation_cleanup_unverified',
          partialDetachedSession(),
          {
            provider: 'tmux',
            operation: 'new-session',
            rawOutput: detachedResult.stdout,
            stderr: detachedResult.stderr,
            ...(freshSocketPathForEvidence ? { socketPath: freshSocketPathForEvidence } : {}),
            ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
          },
        );
      }
      throw new Error(`Failed to create detached tmux session: "${detachedResult.stdout.trim()}"`);
    }
    if (freshDetachedServerIdentity
      && !sameTmuxServerIdentity(detachedRecord.identity, freshDetachedServerIdentity)) {
      const cleaned = await cleanupDetachedSession();
      if (!cleaned) {
        throw new TeamSessionCreationError(
          'tmux_creation_cleanup_unverified',
          partialDetachedSession(),
          {
            provider: 'tmux',
            operation: 'new-session',
            rawOutput: detachedResult.stdout,
            stderr: detachedResult.stderr,
            ...(freshSocketPathForEvidence ? { socketPath: freshSocketPathForEvidence } : {}),
            tmuxServerIdentity: freshDetachedServerIdentity,
          },
        );
      }
      throw new Error('tmux_server_identity_creation_mismatch');
    }
    tmuxServerIdentity = detachedRecord.identity;
    sessionAndWindow = detachedRecord.resource;
    leaderPaneId = detachedRecord.paneId;
    detachedCreationKnown = true;
    createdDetachedSession = true;
    if (freshDetachedServerIdentity) {
      const restored = await runGuardedNativeTmuxCommand(
        tmuxServerIdentity,
        tmuxCommandString(['set-option', '-g', 'exit-empty', 'on']),
      );
      if (restored.outcome !== 'executed') {
        const cleaned = await cleanupDetachedSession();
        if (!cleaned) {
          throw new TeamSessionCreationError(
            'tmux_creation_cleanup_unverified',
            partialDetachedSession(),
            {
              provider: 'tmux',
              operation: 'new-session',
              rawOutput: detachedResult.stdout,
              stderr: detachedResult.stderr,
              ...(freshSocketPathForEvidence ? { socketPath: freshSocketPathForEvidence } : {}),
              tmuxServerIdentity: freshDetachedServerIdentity,
            },
          );
        }
        throw new Error('tmux_server_identity_restore_failed');
      }
    }
    if (await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') {
      const cleaned = await cleanupDetachedSession();
      if (!cleaned) {
        throw new TeamSessionCreationError(
          'tmux_creation_cleanup_unverified',
          partialDetachedSession(),
          {
            provider: 'tmux',
            operation: 'new-session',
            rawOutput: detachedResult.stdout,
            stderr: detachedResult.stderr,
            ...(freshSocketPathForEvidence ? { socketPath: freshSocketPathForEvidence } : {}),
            ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
          },
        );
      }
      throw new Error('tmux_server_identity_revalidation_failed');
    }
  }

  if (inTmux && envPaneId) {
    try {
      const targetedContextResult = await tmuxExecAsync(tmuxArgsForIdentity(tmuxServerIdentity!, [
        'display-message', '-p', '-t', envPaneId, '#S:#I',
      ]), { stripTmux: true, timeout: 2_000 });
      sessionAndWindow = targetedContextResult.stdout.trim();
    } catch {
      sessionAndWindow = '';
      leaderPaneId = '';
    }
  }

  if (!sessionAndWindow || !leaderPaneId) {
    // Fallback when TMUX_PANE is unavailable/invalid.
    const contextResult = await tmuxCmdAsync(tmuxArgsForIdentity(tmuxServerIdentity!, [
      'display-message', '-p', '#S:#I #{pane_id}',
    ]), { stripTmux: true, timeout: 2_000 });
    const contextLine = contextResult.stdout.trim();
    const contextMatch = contextLine.match(/^(\S+)\s+(%\d+)$/);
    if (!contextMatch) {
      throw new Error(`Failed to resolve tmux context: "${contextLine}"`);
    }
    sessionAndWindow = contextMatch[1];
    leaderPaneId = contextMatch[2];
  }

  if (useDedicatedWindow) {
    const targetSession = sessionAndWindow.split(':')[0] ?? sessionAndWindow;
    const windowName = `omc-${sanitizeName(teamName)}`.slice(0, 32);
    const newWindowArgs = [
      'new-window', '-d', '-P', '-F', '#S:#I\t#{pane_id}\t#{socket_path}\t#{pid}',
      '-t', `=${targetSession}`,
      '-n', windowName,
      '-c', cwd,
    ];
    let newWindowResult: Awaited<ReturnType<typeof runGuardedNativeTmuxCommand>>;
    try {
      newWindowResult = await runGuardedNativeTmuxCommand(
        tmuxServerIdentity!,
        tmuxCommandString(newWindowArgs, ['#S:#I\t#{pane_id}\t#{socket_path}\t#{pid}']),
      );
    } catch (error) {
      const creationError = new TeamSessionCreationError(
        `Failed to create team tmux window: ${error instanceof Error ? error.message : String(error)}`,
        partialCreationSession(sessionAndWindow, 'dedicated-window'),
        {
          provider: 'tmux',
          operation: 'new-window',
          rawOutput: '',
          stderr: error instanceof Error ? error.message : String(error),
          ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
        },
      );
      // Guard construction failed before tmux could execute; no allocation
      // exists, so this failure is explicitly verified rather than treated as
      // unknown cleanup.
      creationError.cleanupStatus = 'verified';
      throw creationError;
    }
    const newWindowRecord = newWindowResult.outcome === 'executed'
      ? parseTmuxCreationRecord(
        newWindowResult.stdout,
        4,
        currentStrictProcessStartIdentity,
        tmuxServerIdentity,
      )
      : null;
    if (!newWindowRecord || !sameTmuxServerIdentity(newWindowRecord.identity, tmuxServerIdentity)) {
      const creationError = new TeamSessionCreationError(
        `Failed to create team tmux window: "${newWindowResult.stdout.trim()}"`,
        partialCreationSession(sessionAndWindow, 'dedicated-window'),
        {
          provider: 'tmux',
          operation: 'new-window',
          rawOutput: newWindowResult.stdout,
          stderr: newWindowResult.stderr,
          tmuxServerIdentity,
        },
      );
      if (newWindowResult.outcome === 'not_executed') {
        // The guard explicitly selected its false branch, so no new window
        // was allocated and normal startup rollback may continue.
        creationError.cleanupStatus = 'verified';
      } else {
        // An executed command with malformed output, or an unknown marker,
        // may have allocated a window whose native ID is unavailable. Never
        // enumerate/adopt by name; preserve the typed unknown evidence.
      }
      throw creationError;
    }
    sessionAndWindow = newWindowRecord.resource;
    leaderPaneId = newWindowRecord.paneId;
    sessionMode = 'dedicated-window';
    createdDedicatedWindow = true;
  }

  const teamTarget = sessionAndWindow; // "session:window" or "cmux:workspace" form
  const resolvedSessionName = teamTarget.split(':')[0];

  if (!inCmux && tmuxServerIdentity) {
    try {
      await configureTmuxClipboardAtIdentity(tmuxServerIdentity, `=${resolvedSessionName}:`);
    } catch {
      // Clipboard setup is optional; the final identity revalidation below
      // remains authoritative for publication.
    }
  }

  const partialSession = (): TeamSession => ({
    sessionName: teamTarget,
    leaderPaneId,
    workerPaneIds: [...workerPaneIds],
    sessionMode,
    ...(tmuxServerIdentity
      ? { tmuxServerIdentity: { ...tmuxServerIdentity } }
      : {}),
  });
  const cleanupCreatedResources = async (): Promise<boolean> => {
    if (!tmuxServerIdentity && !inCmux) return false;
    if (untrackedProviderAllocation) {
      // An unknown pane response in a pre-existing shared window cannot be
      // repaired by deleting the previously-known panes: the new pane may
      // still exist. Only death of the original server proves it absent.
      // Detached sessions and dedicated windows are whole containers created
      // by this call, so disposing that complete container is safe.
      const originalServerObservation = tmuxServerIdentity
        ? await observeTmuxServerIdentity(tmuxServerIdentity)
        : 'unknown';
      if (!createdDetachedSession
        && !createdDedicatedWindow
        && originalServerObservation !== 'dead') {
        return false;
      }
    }
    const ownsProviderResource = createdDetachedSession
      || createdDedicatedWindow
      || workerPaneIds.length > 0;
    if (!ownsProviderResource) return true;
    const cleanupTarget = sessionMode === 'detached-session'
      ? resolvedSessionName
      : teamTarget;
    try {
      return await killTeamSession(
        cleanupTarget,
        workerPaneIds,
        leaderPaneId,
        {
          sessionMode,
          ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
        },
      );
    } catch {
      return false;
    }
  };

  if (workerCount <= 0) {
    if (!inCmux) {
      if (!tmuxServerIdentity) throw new Error('tmux_server_identity_unavailable');
      try {
        const result = await runGuardedNativeTmuxCommand(
          tmuxServerIdentity,
          tmuxCommandString(['set-option', '-t', `=${resolvedSessionName}:`, 'mouse', 'on']),
        );
        if (result.outcome !== 'executed') throw new Error('tmux_server_guard_failed');
      } catch {
        // UI preferences are best-effort; identity validation below still
        // prevents publication after an incarnation change.
      }
      if (sessionMode !== 'dedicated-window') {
        try {
          const result = await runGuardedNativeTmuxCommand(
            tmuxServerIdentity,
            tmuxCommandString(['select-pane', '-t', leaderPaneId]),
          );
          if (result.outcome !== 'executed') throw new Error('tmux_server_guard_failed');
        } catch {
          // Selecting the leader is also optional and must not hide the
          // authoritative post-create identity check.
        }
      }
    }
    if (tmuxServerIdentity && await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') {
      const cleaned = await cleanupCreatedResources();
      if (!cleaned) {
        throw new TeamSessionCreationError(
          'tmux_server_identity_revalidation_failed:cleanup_unverified',
          partialSession(),
        );
      }
      throw new Error('tmux_server_identity_revalidation_failed');
    }
    return {
      sessionName: teamTarget,
      leaderPaneId,
      workerPaneIds,
      sessionMode,
      ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    };
  }

  // Create worker panes: first via horizontal split off leader, rest stacked vertically on right.
  // Every post-create required step remains inside this rollback boundary so a
  // failed layout/association cannot strand panes without ownership evidence.
  try {
  for (let i = 0; i < workerCount; i++) {
    const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
    if (inCmux) {
      const direction = i === 0 ? 'right' : 'down';
      const split = await cmuxSplitSurface(splitTarget, direction, cwd);
      if (!split.paneId) {
        const creationError = new TeamSessionCreationError(
          `Failed to resolve cmux surface id: ${JSON.stringify(split.stdout.trim())}`,
          partialSession(),
          {
            provider: 'cmux',
            operation: 'new-split',
            rawOutput: split.stdout,
            stderr: split.stderr,
          },
        );
        untrackedProviderAllocation = true;
        throw creationError;
      }
      workerPaneIds.push(split.paneId);
      continue;
    }

    const splitType = i === 0 ? '-h' : '-v';
    const splitArgs = [
      'split-window', splitType, '-t', splitTarget,
      '-d', '-P', '-F', '#{pane_id}\t#{socket_path}\t#{pid}',
      '-c', cwd,
      ...workerPaneShellCommand(),
    ];
    const splitResult = await runGuardedNativeTmuxCommand(
      tmuxServerIdentity!,
      tmuxCommandString(splitArgs, ['#{pane_id}\t#{socket_path}\t#{pid}']),
    );
    if (splitResult.outcome !== 'executed') {
      const creationError = new TeamSessionCreationError(
        `tmux_server_guard_${splitResult.outcome}`,
        partialSession(),
        {
          provider: 'tmux',
          operation: 'split-window',
          rawOutput: splitResult.stdout,
          stderr: splitResult.stderr,
          tmuxServerIdentity,
        },
      );
      if (splitResult.outcome === 'not_executed') {
        // The explicit false branch proves that the native command was not
        // entered; previously-known panes may still be cleaned normally.
        creationError.cleanupStatus = 'verified';
      } else {
        // A missing/timeout marker leaves the native allocation untracked.
        // Shared-window cleanup must not claim success from old pane IDs.
        untrackedProviderAllocation = true;
      }
      throw creationError;
    }
    const splitRecord = parseTmuxCreationRecord(
      splitResult.stdout,
      3,
      currentStrictProcessStartIdentity,
      tmuxServerIdentity,
    );
    if (!splitRecord || !sameTmuxServerIdentity(splitRecord.identity, tmuxServerIdentity)) {
      const creationError = new TeamSessionCreationError(
        `Failed to create team tmux pane: "${splitResult.stdout.trim()}"`,
        partialSession(),
        {
          provider: 'tmux',
          operation: 'split-window',
          rawOutput: splitResult.stdout,
          stderr: splitResult.stderr,
          tmuxServerIdentity,
        },
      );
      untrackedProviderAllocation = true;
      throw creationError;
    }
    workerPaneIds.push(splitRecord.paneId);
  }

  if (!inCmux) {
    await applyMainVerticalLayout(teamTarget, { required: true, tmuxServerIdentity });

    try {
      const result = await runGuardedNativeTmuxCommand(
        tmuxServerIdentity!,
        tmuxCommandString(['set-option', '-t', `=${resolvedSessionName}:`, 'mouse', 'on']),
      );
      if (result.outcome !== 'executed') throw new Error('tmux_server_guard_failed');
    } catch {
      // Optional UI preference; do not publish without the final identity
      // check below.
    }

    if (sessionMode !== 'dedicated-window') {
      try {
        const result = await runGuardedNativeTmuxCommand(
          tmuxServerIdentity!,
          tmuxCommandString(['select-pane', '-t', leaderPaneId]),
        );
        if (result.outcome !== 'executed') throw new Error('tmux_server_guard_failed');
      } catch {
        // Optional focus selection; creation identity remains authoritative.
      }
    }
  }
  } catch (error) {
    const cleaned = await cleanupCreatedResources();
    if (!cleaned) {
      throw new TeamSessionCreationError(
        `tmux_creation_cleanup_unverified:${error instanceof Error ? error.message : String(error)}`,
        partialSession(),
        error instanceof TeamSessionCreationError ? error.creationEvidence : undefined,
      );
    }
    if (error instanceof TeamSessionCreationError) error.cleanupStatus = 'verified';
    throw error;
  }
  try {
    await Promise.all(workerPaneIds.map((workerPaneId) => waitForShellReady(workerPaneId, {
      timeoutMs: 5_000,
      tmuxServerIdentity,
    })));

    if (tmuxServerIdentity && await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') {
      throw new Error('tmux_server_identity_revalidation_failed');
    }
  } catch (error) {
    const cleaned = await cleanupCreatedResources();
    if (!cleaned) {
      throw new TeamSessionCreationError(
        `tmux_creation_cleanup_unverified:${error instanceof Error ? error.message : String(error)}`,
        partialSession(),
        error instanceof TeamSessionCreationError ? error.creationEvidence : undefined,
      );
    }
    if (error instanceof TeamSessionCreationError) error.cleanupStatus = 'verified';
    throw error;
  }
  return {
    sessionName: teamTarget,
    leaderPaneId,
    workerPaneIds,
    sessionMode,
    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
  };
}

/**
 * Spawn a CLI agent in a specific pane.

 * Worker startup: env OMC_TEAM_WORKER={teamName}/workerName shell -lc "exec agentCmd"
 */
export async function spawnWorkerInPane(
  sessionName: string,
  paneId: string,
  config: WorkerPaneConfig
): Promise<void> {
  validateTeamName(config.teamName);
  const ownedTmuxIdentity = config.tmuxServerIdentity;
  if (!isCmuxSurfaceTarget(paneId) && !ownedTmuxIdentity) {
    throw new Error('worker_start_tmux_server_identity_missing');
  }
  if (ownedTmuxIdentity) {
    if (!isValidTmuxServerIdentity(ownedTmuxIdentity)
      || await observeTmuxServerIdentity(ownedTmuxIdentity) !== 'matching') {
      throw new Error('worker_start_tmux_server_identity_unverified');
    }
  }
  if (config.launchAttempt && config.launchAttempt.pane_id !== paneId) {
    throw new Error('worker_launch_attempt_pane_mismatch');
  }
  let startCmd = '';
  let fingerprint = config.launchAttempt?.attempt_id.slice(0, 12) ?? 'unbuilt';
  let materializedTransport: Awaited<ReturnType<typeof materializeWorkerLaunchTransport>> | undefined;
  const nativeAttemptTransport = process.platform === 'win32'
    && !isUnixLikeOnWindows()
    && Boolean(config.launchAttempt)
    && !isCmuxSurfaceTarget(paneId);
  const supervisedLaunch = Boolean(config.launchAttempt);
  const requireAcknowledgement = async (): Promise<void> => {
    if (!config.launchAttempt) return;
    const accepted = await awaitWorkerLaunchAcknowledgement(config.launchAttempt);
    if (!accepted.ok) {
      throw new Error(`worker_start_ack_${accepted.reason}:${config.workerName}:${paneId}:${config.launchAttempt.attempt_id.slice(0, 12)}`);
    }
    if (!await awaitWorkerLaunchProviderStarted(config.launchAttempt)) {
      throw new Error(`worker_start_provider_failed:${config.workerName}:${paneId}:${config.launchAttempt.attempt_id.slice(0, 12)}`);
    }
  };

  try {
    if (supervisedLaunch && config.launchAttempt) {
      // Every supervised launch (Windows native, cmux surface, or POSIX tmux)
      // materializes the attempt-owned transport: owner + bootstrap descriptor
      // + wrapper. Native Windows then delivers the wrapper command; POSIX and
      // cmux deliver the runtime CLI invocation pointing at the descriptor.
      materializedTransport = await materializeWorkerLaunchTransport({
        attempt: config.launchAttempt,
        providerArgv: getLaunchWords(config),
        cwd: config.cwd,
        providerEnv: config.envVars,
        releaseAfterSpawn: Boolean(config.envVars.OMC_RECOVERY_GATE_SPEC),
        windowsDelivery: nativeAttemptTransport,
      });
      startCmd = nativeAttemptTransport
        ? materializedTransport.wrapperRelativePath
        : buildWorkerStartCommand(config);
    } else {
      startCmd = buildWorkerStartCommand(config);
    }
    const transportKind = nativeAttemptTransport
      ? 'attempt_wrapper'
      : supervisedLaunch
        ? 'attempt_descriptor'
        : 'inline';
    fingerprint = commandFingerprint(startCmd);
    const commandBytes = Buffer.byteLength(startCmd, 'utf8');
    logWorkerSpawnDiagnostic(
      `worker start delivery begin session=${sessionName} pane=${paneId} ` +
      `worker=${config.workerName} cmdSha=${fingerprint} cmdBytes=${commandBytes} ` +
      `transport=${transportKind}`,
    );

    if (isCmuxSurfaceTarget(paneId)) {
      await cmuxSendSurface(paneId, startCmd);
      await cmuxSendSurfaceKey(paneId, 'Enter');
      await requireAcknowledgement();
      logWorkerSpawnDiagnostic(
        `worker start delivery accepted session=${sessionName} pane=${paneId} ` +
        `worker=${config.workerName} cmdSha=${fingerprint}`,
      );
      return;
    }

    const shellReady = await waitForShellReady(paneId, {
      tmuxServerIdentity: ownedTmuxIdentity,
    });
    if (!shellReady) {
      throw new Error(`worker_start_shell_not_ready:${config.workerName}:${paneId}:${fingerprint}`);
    }

    const sendArgs = ['send-keys', '-t', paneId, '-l', startCmd];
    const sendResult = await (async () => {
      const result = await runGuardedNativeTmuxCommand(
        ownedTmuxIdentity!,
        tmuxCommandString(sendArgs),
      );
      if (result.outcome !== 'executed') throw new Error('worker_start_tmux_server_guard_failed');
      return result;
    })();
    logWorkerSpawnDiagnostic(
      `worker start send-keys literal session=${sessionName} pane=${paneId} ` +
      `worker=${config.workerName} cmdSha=${fingerprint} cmdBytes=${commandBytes} ` +
      `sendStatus=0 stderr=${JSON.stringify(redactBoundedDiagnostic(sendResult.stderr))}`,
    );

    if (!config.launchAttempt) {
      const delivered = await verifyWorkerStartCommandDelivered(
        paneId,
        startCmd,
        ownedTmuxIdentity,
      );
      if (!delivered) {
        throw new Error(`worker_start_delivery_unverified:${config.workerName}:${paneId}:${fingerprint}`);
      }
    }

    const enterArgs = ['send-keys', '-t', paneId, 'Enter'];
    const enterResult = await (async () => {
      const result = await runGuardedNativeTmuxCommand(
        ownedTmuxIdentity!,
        tmuxCommandString(enterArgs),
      );
      if (result.outcome !== 'executed') throw new Error('worker_start_tmux_server_guard_failed');
      return result;
    })();
    logWorkerSpawnDiagnostic(
      `worker start submit key sent session=${sessionName} pane=${paneId} ` +
      `worker=${config.workerName} cmdSha=${fingerprint} cmdBytes=${commandBytes} ` +
      `sendStatus=0 stderr=${JSON.stringify(redactBoundedDiagnostic(enterResult.stderr))}`,
    );
    if (nativeAttemptTransport) {
      const [status, observation] = await Promise.all([
        getPaneCurrentCommandStatus(paneId, ownedTmuxIdentity),
        capturePaneObservation(paneId, {
          operation: 'worker-start-post-enter',
          ...(ownedTmuxIdentity ? { tmuxServerIdentity: ownedTmuxIdentity } : {}),
        }),
      ]);
      const captured = observation.ok ? observation.captured : '';
      const captureSha = captured ? commandFingerprint(captured) : 'none';
      logWorkerSpawnDiagnostic(
        `worker start post-enter observation session=${sessionName} pane=${paneId} ` +
        `worker=${config.workerName} cmdSha=${fingerprint} paneStatus=${JSON.stringify(status
          ? `${status.dead ? '1' : '0'} ${redactBoundedDiagnostic(status.command, 96)}` : 'unavailable')} ` +
        `captureOk=${observation.ok} captureBytes=${Buffer.byteLength(captured, 'utf8')} captureSha=${captureSha}`,
      );
    }

    if (config.launchAttempt) {
      await requireAcknowledgement();
    } else {
      const submitted = await verifyWorkerStartCommandSubmitted(paneId, startCmd, {
        tmuxServerIdentity: ownedTmuxIdentity,
      });
      if (!submitted) {
        throw new Error(`worker_start_submit_unverified:${config.workerName}:${paneId}:${fingerprint}`);
      }
    }
  } catch (error) {
    if (config.launchAttempt) {
      await revokeWorkerLaunchAttempt(config.launchAttempt, 'launch_failed').catch(() => undefined);
    }
    if (config.launchAttempt
      && (!materializedTransport || existsSync(materializedTransport.bootstrapDescriptorPath))) {
      const cleaned = await cleanupWorkerLaunchTransport(config.launchAttempt, 'launch_failed')
        .catch(() => false);
      if (!cleaned) {
        logWorkerSpawnDiagnostic(
          `worker start transport cleanup unverified session=${sessionName} pane=${paneId} ` +
          `worker=${config.workerName} cmdSha=${fingerprint}`,
        );
      }
    }
    logWorkerSpawnDiagnostic(
      `worker start failed session=${sessionName} pane=${paneId} worker=${config.workerName} ` +
      `cmdSha=${fingerprint} error=${JSON.stringify(redactBoundedDiagnostic(error))}`,
    );
    throw error;
  }
}

export async function spawnOwnedWorkerInPane(
  sessionName: string,
  ownership: WorkerPaneOwnership,
  config: WorkerPaneConfig,
): Promise<StartupPaneContext> {
  if (ownership.provider === 'tmux' && !isValidTmuxServerIdentity(ownership.tmuxServerIdentity)) {
    throw new Error('worker_launch_tmux_server_identity_missing');
  }
  if (!config.provider) throw new Error('worker_launch_provider_missing');
  if (!config.launchBootstrapPath) throw new Error('worker_launch_bootstrap_path_missing');
  if (!config.launchStateCwd) throw new Error('worker_launch_state_cwd_missing');
  const instanceId = config.instanceId;
  if (!isValidTeamInstanceId(instanceId)) throw new Error('worker_launch_instance_id_invalid');
  const attempt = await prepareWorkerLaunchAttempt({
    cwd: config.launchStateCwd,
    teamName: config.teamName,
    workerName: config.workerName,
    instanceId,
    paneId: ownership.paneId,
    provider: config.provider,
    runtimeCliPath: config.launchBootstrapPath,
    ...(config.launchContext ? { context: config.launchContext } : {}),
  });
  try {
    const launchEnv: Record<string, string> = {
      ...config.envVars,
      OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id,
    };
    if (launchEnv.OMC_RECOVERY_GATE_SPEC) {
      const gate = JSON.parse(launchEnv.OMC_RECOVERY_GATE_SPEC) as Record<string, unknown>;
      launchEnv.OMC_RECOVERY_GATE_SPEC = JSON.stringify({ ...gate, launchAttempt: attempt });
    }
    await spawnWorkerInPane(sessionName, ownership.paneId, {
      ...config,
      envVars: launchEnv,
      launchAttempt: attempt,
      ...(ownership.provider === 'tmux' && ownership.tmuxServerIdentity
        ? { tmuxServerIdentity: ownership.tmuxServerIdentity }
        : {}),
    });
    return { ownership, attempt, provider: config.provider };
  } catch (error) {
    const cleaned = await retireAndCleanupCurrentWorkerLaunchAttempt(attempt, 'launch_failed', async () => {
      try {
        await killOwnedWorkerPane(ownership);
        return await getOwnedWorkerLiveness(ownership) === 'dead';
      } catch {
        return false;
      }
    }).catch(() => false);
    if (!cleaned) throw new Error(`worker_launch_cleanup_unverified:${config.workerName}:${ownership.paneId}`);
    throw error;
  }
}

function normalizeTmuxCapture(value: string): string {
  return value.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeTmuxCaptureForDelivery(value: string): string {
  return value.replace(/\r/g, '').replace(/\s+/g, '');
}

export type PaneCaptureObservation =
  | { ok: true; captured: string }
  | { ok: false; error: string };

function safePaneDiagnosticToken(paneId: string): string {
  return paneId.replace(/[^A-Za-z0-9%._:-]/g, '?').slice(0, 128);
}

async function capturePaneObservation(
  paneId: string,
  opts: {
    joinWrappedLines?: boolean;
    operation?: string;
    tmuxServerIdentity?: TmuxServerIdentity;
  } = {},
): Promise<PaneCaptureObservation> {
  try {
    if (isCmuxSurfaceTarget(paneId)) {
      return { ok: true, captured: await cmuxCaptureSurface(paneId) };
    }
    if (opts.tmuxServerIdentity) {
      if (!isValidTmuxServerIdentity(opts.tmuxServerIdentity)
        || await observeTmuxServerIdentity(opts.tmuxServerIdentity) !== 'matching') {
        return { ok: false, error: 'tmux_server_identity_unverified' };
      }
    }
    const args = opts.joinWrappedLines
      ? ['capture-pane', '-J', '-t', paneId, '-p', '-S', '-80']
      : ['capture-pane', '-t', paneId, '-p', '-S', '-80'];
    const result = opts.tmuxServerIdentity
      ? await tmuxExecAsync(
        tmuxArgsForIdentity(opts.tmuxServerIdentity, args),
        { timeout: 2_000, stripTmux: true },
      )
      : await tmuxExecAsync(args);
    if (opts.tmuxServerIdentity
      && await observeTmuxServerIdentity(opts.tmuxServerIdentity) !== 'matching') {
      return { ok: false, error: 'tmux_server_identity_changed' };
    }
    return { ok: true, captured: result.stdout };
  } catch (error) {
    const operation = (opts.operation ?? 'capture').replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64);
    const message = redactBoundedDiagnostic(error);
    logWorkerSpawnDiagnostic(
      `pane capture failed operation=${operation} pane=${safePaneDiagnosticToken(paneId)} error=${JSON.stringify(message)}`,
    );
    return { ok: false, error: message };
  }
}

async function capturePaneAsync(
  paneId: string,
  opts: {
    joinWrappedLines?: boolean;
    operation?: string;
    tmuxServerIdentity?: TmuxServerIdentity;
  } = {},
): Promise<string> {
  const observation = await capturePaneObservation(paneId, opts);
  return observation.ok ? observation.captured : '';
}

export async function captureTeamPane(
  paneId: string,
  options: { tmuxServerIdentity?: TmuxServerIdentity } = {},
): Promise<string> {
  return capturePaneAsync(paneId, options);
}

/** Capture an owned pane only while the original tmux incarnation matches. */
export async function captureOwnedTeamPane(ownership: WorkerPaneOwnership): Promise<string> {
  if (ownership.provider === 'cmux') return captureTeamPane(ownership.paneId);
  if (!isValidTmuxServerIdentity(ownership.tmuxServerIdentity)
    || !TMUX_MAILBOX_PANE_ID.test(ownership.paneId)) return '';
  return captureTeamPane(ownership.paneId, {
    tmuxServerIdentity: ownership.tmuxServerIdentity,
  });
}

export async function sendTeamPaneKey(
  paneId: string,
  key: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<void> {
  if (isCmuxSurfaceTarget(paneId)) {
    await cmuxSendSurfaceKey(paneId, key);
    return;
  }
  if (!tmuxServerIdentity) throw new Error('tmux_server_identity_missing');
  if (!isValidTmuxServerIdentity(tmuxServerIdentity)
    || await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') {
    throw new Error('tmux_server_identity_unverified');
  }
  const result = await runGuardedNativeTmuxCommand(
    tmuxServerIdentity,
    tmuxCommandString(['send-keys', '-t', paneId, key]),
  );
  if (result.outcome !== 'executed') throw new Error('tmux_server_guard_failed');
}

async function guardedSendLiteralAndEnter(
  paneId: string,
  text: string,
  tmuxServerIdentity: TmuxServerIdentity,
): Promise<boolean> {
  if (!isValidTmuxServerIdentity(tmuxServerIdentity)
    || await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') return false;
  const literal = await runGuardedNativeTmuxCommand(
    tmuxServerIdentity,
    tmuxCommandString(['send-keys', '-t', paneId, '-l', '--', text]),
  );
  if (literal.outcome !== 'executed') return false;
  const enter = await runGuardedNativeTmuxCommand(
    tmuxServerIdentity,
    tmuxCommandString(['send-keys', '-t', paneId, 'Enter']),
  );
  return enter.outcome === 'executed';
}

export async function killTeamPane(paneId: string): Promise<void> {
  if (isCmuxSurfaceTarget(paneId)) {
    await cmuxCloseSurface(paneId);
    return;
  }
  throw new Error('tmux_server_identity_required');
}

export async function killOwnedWorkerPane(ownership: WorkerPaneOwnership): Promise<void> {
  if (ownership.paneId === ownership.leaderPaneId) {
    throw new Error('owned_pane_leader_excluded');
  }
  if (ownership.reservedPaneIds.includes(ownership.paneId)) {
    throw new Error('owned_pane_reserved_excluded');
  }
  if (ownership.provider === 'tmux') {
    if (!isValidTmuxServerIdentity(ownership.tmuxServerIdentity)) {
      throw new Error('owned_pane_tmux_server_identity_missing');
    }
    const serverState = await observeTmuxServerIdentity(ownership.tmuxServerIdentity);
    if (serverState === 'dead') return;
    if (serverState !== 'matching') {
      throw new Error('owned_pane_tmux_server_identity_unknown');
    }
  }

  const membership = await verifyTeamTargetOwnership({
    provider: ownership.provider,
    providerTarget: ownership.providerTarget,
    recipient: 'worker',
    recipientRole: 'worker',
    paneId: ownership.paneId,
    ...(ownership.provider === 'tmux'
      ? { tmuxServerIdentity: ownership.tmuxServerIdentity }
      : {}),
  } as MailboxNotificationTarget);
  if (membership.kind !== 'owned') throw new Error('owned_pane_membership_unverified');
  if (ownership.provider === 'cmux') {
    await cmuxCloseSurface(ownership.paneId);
    return;
  }
  const result = await runGuardedNativeTmuxCommand(
    ownership.tmuxServerIdentity!,
    tmuxCommandString(['kill-pane', '-t', ownership.paneId]),
  );
  if (result.outcome !== 'executed') {
    throw new Error('owned_pane_tmux_server_guard_failed');
  }
}

type PaneTrustPromptKind = 'directory' | 'codex_hooks' | 'cursor_workspace_trust';

function detectPaneTrustPromptKind(captured: string, provider?: CliAgentType): PaneTrustPromptKind | null {
  const lines = captured.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
  const tail = lines.slice(-12);

  const hasCursorTrustBanner = tail.some(l => /Workspace Trust Required/i.test(l));
  const hasCursorTrustHint = tail.some(l => /Pass\s+--trust,\s*--yolo,\s*or\s+-f/i.test(l));
  if ((provider === undefined || provider === 'cursor')
    && hasCursorTrustBanner && (hasCursorTrustHint || tail.some(l => /Do you trust the contents of this directory\?/i.test(l)))) {
    return 'cursor_workspace_trust';
  }

  const hasDirectoryQuestion = tail.some(l => /Do you trust the contents of this directory\?/i.test(l));
  const hasDirectoryChoices = tail.some(l => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(l));
  if (hasDirectoryQuestion && hasDirectoryChoices) return 'directory';

  // cursor-agent asks the same question but offers no selectable answer: it
  // prints "Workspace Trust Required", tells the operator to pass --trust/-f,
  // and exits. There is nothing to dismiss, so this is reported as its own
  // kind and never answered with keystrokes. Launch args carry `--force
  // --trust` precisely so this state is unreachable; seeing it means a pane
  // was started without them.
  const hasHookReview = tail.some(l => /Hooks need review/i.test(l));
  const hasHookTrustChoice = tail.some(l => /Continue without trusting/i.test(l));
  const hasHookConfirm = tail.some(l => /Press enter to confirm or esc to go back/i.test(l));
  if (hasHookReview && hasHookTrustChoice && hasHookConfirm) return 'codex_hooks';

  return null;
}

export function paneHasTrustPrompt(captured: string, provider?: CliAgentType): boolean {
  return detectPaneTrustPromptKind(captured, provider) !== null;
}

export function paneHasCursorWorkspaceTrustPrompt(captured: string): boolean {
  return detectPaneTrustPromptKind(captured, 'cursor') === 'cursor_workspace_trust';
}

function paneHasClaudeStartupBanner(captured: string, provider?: CliAgentType): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0)
    .slice(-20);
  const lastPromptIndex = lines.findLastIndex(line => paneLineLooksLikeIdlePrompt(line, provider));
  // Claude Code v2.1.x renders the permission-mode indicator
  // ("⏵⏵ bypass permissions on (shift+tab to cycle)") *below* the prompt
  // as a persistent idle-state UI element. If a prompt is present anywhere
  // in the tail, the pane has finished bootstrapping and the banner is an
  // idle mode indicator, not a startup signal.
  if (lastPromptIndex >= 0) return false;
  const lastStartupBannerIndex = lines.findLastIndex((line) =>
    /bypass\s+permissions\s+on/i.test(line)
    || /shift\+tab\s+to\s+cycle/i.test(line)
    || /^⏵⏵\s+/.test(line),
  );
  return lastStartupBannerIndex >= 0;
}

function paneIsBootstrapping(captured: string, provider?: CliAgentType): boolean {
  if (paneHasClaudeStartupBanner(captured, provider)) return true;
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  return lines.some((line) =>
    /\b(loading|initializing|starting up)\b/i.test(line)
    || /\bmodel:\s*loading\b/i.test(line)
    || /\bconnecting\s+to\b/i.test(line),
  );
}

export function paneHasActiveTask(captured: string, provider?: CliAgentType): boolean {
  const lines = captured.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(l => l.length > 0);
  const tail = lines.slice(-40);
  if (provider === 'cursor' && tail.some(l => /ctrl\+c\s+to\s+stop/i.test(l))) return true;
  if (tail.some(l => /\b\d+\s+background terminal running\b/i.test(l))) return true;
  if (tail.some(l => /esc to interrupt/i.test(l))) return true;
  if (tail.some(l => /\bbackground terminal running\b/i.test(l))) return true;
  if (tail.some(l => /^[·✻]\s+[A-Za-z][A-Za-z0-9''-]*(?:\s+[A-Za-z][A-Za-z0-9''-]*){0,3}(?:…|\.{3})$/u.test(l))) return true;
  return false;
}

export function paneLooksReady(captured: string, provider?: CliAgentType): boolean {
  const content = captured.trimEnd();
  if (content === '') return false;
  const lines = content
    .split('\n')
    .map(line => line.replace(/\r/g, '').trimEnd())
    .filter(line => line.trim() !== '');
  if (lines.length === 0) return false;
  // A dismissible trust prompt still means the CLI is up and answering. The
  // cursor workspace-trust banner is the opposite: the process already exited,
  // so the pane is not ready and never will be without `--trust`.
  if (detectPaneTrustPromptKind(content, provider) === 'cursor_workspace_trust') return false;
  if (paneHasTrustPrompt(content, provider)) return true;
  if (paneIsBootstrapping(content, provider)) return false;

  const lastLine = lines[lines.length - 1]!;
  if (paneLineLooksLikeIdlePrompt(lastLine, provider)) return true;
  return lines.some(line => paneLineLooksLikeIdlePrompt(line, provider));
}

export interface WaitForPaneReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  attemptAlreadyFenced?: boolean;
  provider?: CliAgentType;
  tmuxServerIdentity?: TmuxServerIdentity;
}

export async function waitForPaneReady(
  paneId: string,
  opts: WaitForPaneReadyOptions = {}
): Promise<boolean> {
  if (!isCmuxSurfaceTarget(paneId) && !opts.tmuxServerIdentity) return false;
  const envTimeout = Number.parseInt(process.env.OMC_SHELL_READY_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
    ? Number(opts.timeoutMs)
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000);
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0
    ? Number(opts.pollIntervalMs)
    : 250;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = await capturePaneAsync(paneId, {
      tmuxServerIdentity: opts.tmuxServerIdentity,
    });
    if (paneLooksReady(captured, opts.provider) && !paneHasActiveTask(captured, opts.provider)) {
      return true;
    }
    await sleep(pollIntervalMs);
  }

  console.warn(
    `[tmux-session] waitForPaneReady: pane ${paneId} timed out after ${timeoutMs}ms ` +
    `(set OMC_SHELL_READY_TIMEOUT_MS to tune)`
  );
  return false;
}

function paneTailContainsLiteralLine(captured: string, text: string): boolean {
  return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(text));
}

async function paneCopyModeObservation(
  paneId: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<boolean | null> {
  if (isCmuxSurfaceTarget(paneId)) return false;
  if (!tmuxServerIdentity) return null;
  if (!isValidTmuxServerIdentity(tmuxServerIdentity)
    || await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') return null;
  try {
    const result = await tmuxCmdAsync(
      tmuxArgsForIdentity(tmuxServerIdentity, ['display-message', '-t', paneId, '-p', '#{pane_in_mode}']),
      { timeout: 2_000, stripTmux: true },
    );
    if (result.stderr.trim()) return null;
    if (await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') return null;
    const state = result.stdout.trim();
    return state === '1' ? true : state === '0' ? false : null;
  } catch (error) {
    logWorkerSpawnDiagnostic(
      `pane query failed operation=copy-mode pane=${safePaneDiagnosticToken(paneId)} error=${JSON.stringify(redactBoundedDiagnostic(error))}`,
    );
    return null;
  }
}

async function paneInCopyMode(paneId: string): Promise<boolean> {
  return (await paneCopyModeObservation(paneId)) ?? false;
}

export type StartupPaneReadyResult =
  | { ok: true }
  | { ok: false; reason: 'attempt_inactive' | 'ownership_mismatch' | 'copy_mode' | 'copy_mode_unknown' | 'capture_failed' | 'selector_unsupported' | 'selector_persistent' | 'cursor_workspace_untrusted' | 'pane_busy' | 'readiness_timeout' };

async function sendLiteralPaneText(
  paneId: string,
  text: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<void> {
  if (isCmuxSurfaceTarget(paneId)) {
    await cmuxSendSurface(paneId, text);
    return;
  }
  if (!tmuxServerIdentity) throw new Error('tmux_server_identity_missing');
  if (!isValidTmuxServerIdentity(tmuxServerIdentity)
    || await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') {
    throw new Error('tmux_server_identity_unverified');
  }
  const result = await runGuardedNativeTmuxCommand(
    tmuxServerIdentity,
    tmuxCommandString(['send-keys', '-t', paneId, '-l', '--', text]),
  );
  if (result.outcome !== 'executed') throw new Error('tmux_server_guard_failed');
}

async function startupContextIsActive(context: StartupPaneContext, attemptAlreadyFenced = false): Promise<boolean> {
  if (context.ownership.provider === 'tmux'
    && !isValidTmuxServerIdentity(context.ownership.tmuxServerIdentity)) return false;
  return context.ownership.paneId === context.attempt.pane_id
    && context.provider === context.attempt.provider
    && await isWorkerLaunchAttemptAccepted(context.attempt)
    && (attemptAlreadyFenced || await isWorkerLaunchAttemptCurrent(context.attempt));
}

export async function waitForStartupPaneReady(
  context: StartupPaneContext,
  opts: WaitForPaneReadyOptions = {},
): Promise<StartupPaneReadyResult> {
  if (context.ownership.paneId !== context.attempt.pane_id || context.provider !== context.attempt.provider) {
    return { ok: false, reason: 'ownership_mismatch' };
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? Number(opts.timeoutMs) : 30_000;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0 ? Number(opts.pollIntervalMs) : 250;
  const deadline = Date.now() + timeoutMs;
  const handledSelectors = new Set<PaneTrustPromptKind>();

  while (Date.now() < deadline) {
    if (!await startupContextIsActive(context, opts.attemptAlreadyFenced)) return { ok: false, reason: 'attempt_inactive' };
    const copyMode = await paneCopyModeObservation(
      context.ownership.paneId,
      context.ownership.tmuxServerIdentity,
    );
    if (copyMode === null) return { ok: false, reason: 'copy_mode_unknown' };
    if (copyMode) return { ok: false, reason: 'copy_mode' };
    const observation = await capturePaneObservation(context.ownership.paneId, {
      operation: 'startup-readiness',
      ...(context.ownership.provider === 'tmux'
        ? { tmuxServerIdentity: context.ownership.tmuxServerIdentity }
        : {}),
    });
    if (!observation.ok) return { ok: false, reason: 'capture_failed' };
    const captured = observation.captured;
    const selector = detectPaneTrustPromptKind(captured, context.provider);
    if (selector) {
      // cursor-agent's workspace-trust banner has no selectable answer and the
      // process is already gone, so there is nothing to drive. Report it under
      // its own reason instead of blocking until readiness_timeout.
      if (selector === 'cursor_workspace_trust') {
        return { ok: false, reason: 'cursor_workspace_untrusted' };
      }
      const providerSupportsSelector = selector === 'codex_hooks'
        ? context.provider === 'codex'
        : context.provider === 'codex' || context.provider === 'claude';
      if (!providerSupportsSelector) return { ok: false, reason: 'selector_unsupported' };
      if (handledSelectors.has(selector)) return { ok: false, reason: 'selector_persistent' };
      await sendLiteralPaneText(
        context.ownership.paneId,
        selector === 'directory' ? '1' : '3',
        context.ownership.tmuxServerIdentity,
      );
      await sendTeamPaneKey(
        context.ownership.paneId,
        'Enter',
        context.ownership.tmuxServerIdentity,
      );
      handledSelectors.add(selector);
      await sleep(pollIntervalMs);
      continue;
    }
    if (paneHasActiveTask(captured, context.provider)) return { ok: false, reason: 'pane_busy' };
    if (paneLooksReady(captured, context.provider)) return { ok: true };
    await sleep(pollIntervalMs);
  }
  return { ok: false, reason: 'readiness_timeout' };
}

export async function deliverStartupInbox(
  context: StartupPaneContext,
  message: string,
  options: { attemptAlreadyFenced?: boolean } = {},
): Promise<{ ok: true; kind: 'attempted_unconfirmed' } | { ok: false; reason: string }> {
  if (message.length > 200) return { ok: false, reason: 'message_too_long' };
  const ready = await waitForStartupPaneReady(context, { attemptAlreadyFenced: options.attemptAlreadyFenced });
  if (!ready.ok) return { ok: false, reason: ready.reason };
  try {
    await sendLiteralPaneText(
      context.ownership.paneId,
      message,
      context.ownership.tmuxServerIdentity,
    );
    await sleep(100);
    await sendTeamPaneKey(context.ownership.paneId, 'C-m', context.ownership.tmuxServerIdentity);
    await sleep(120);
    await sendTeamPaneKey(context.ownership.paneId, 'C-m', context.ownership.tmuxServerIdentity);
    return { ok: true, kind: 'attempted_unconfirmed' };
  } catch (error) {
    logWorkerSpawnDiagnostic(
      `startup inbox attempt failed pane=${safePaneDiagnosticToken(context.ownership.paneId)} ` +
      `attempt=${context.attempt.attempt_id.slice(0, 12)} error=${JSON.stringify(redactBoundedDiagnostic(error))}`,
    );
    return { ok: false, reason: 'startup_send_failed' };
  }
}

/**
 * Outcome of a startup-inbox resubmit probe:
 * - `resubmitted` — the trigger was still visibly pending and Enter was re-sent.
 * - `pane_busy` — the owned pane shows an active task: the worker consumed the
 *   trigger and is working, so resubmitting would duplicate the inbox. Callers
 *   must keep waiting for startup evidence instead of tearing the launch down.
 * - `unavailable` — the pane cannot be re-submitted into (inactive attempt,
 *   copy mode, capture failure, selector, or the trigger text is gone).
 */
export type StartupInboxResubmitOutcome = 'resubmitted' | 'pane_busy' | 'unavailable';

/**
 * Read-only observation of the pane after the startup trigger was delivered.
 * `busy` is the only state that can extend the evidence wait; all other
 * outcomes fail closed to the normal final recheck. This probe intentionally
 * never inspects or mutates the input buffer, so it cannot resubmit Enter.
 */
export type StartupPaneActivity = 'busy' | 'idle' | 'dead' | 'unknown';

export async function probeStartupPaneActivity(
  context: StartupPaneContext,
  options: { attemptAlreadyFenced?: boolean } = {},
): Promise<StartupPaneActivity> {
  if (!await startupContextIsActive(context, options.attemptAlreadyFenced)) return 'unknown';

  const membership = await verifyTeamTargetOwnership({
    provider: context.ownership.provider,
    providerTarget: context.ownership.providerTarget,
    recipient: 'worker',
    recipientRole: 'worker',
    paneId: context.ownership.paneId,
    ...(context.ownership.provider === 'tmux'
      ? { tmuxServerIdentity: context.ownership.tmuxServerIdentity }
      : {}),
  } as MailboxNotificationTarget);
  if (membership.kind !== 'owned') return 'unknown';

  const liveness = await getOwnedWorkerLiveness(context.ownership);
  if (liveness !== 'alive') return liveness;

  const copyMode = await paneCopyModeObservation(
    context.ownership.paneId,
    context.ownership.tmuxServerIdentity,
  );
  if (copyMode !== false) return 'unknown';

  const observation = await capturePaneObservation(context.ownership.paneId, {
    operation: 'startup-activity-probe',
    ...(context.ownership.provider === 'tmux'
      ? { tmuxServerIdentity: context.ownership.tmuxServerIdentity }
      : {}),
  });
  if (!observation.ok) return 'unknown';
  if (detectPaneTrustPromptKind(observation.captured, context.provider)) return 'idle';
  return paneHasActiveTask(observation.captured, context.provider) ? 'busy' : 'idle';
}

export async function retryStartupInboxSubmit(
  context: StartupPaneContext,
  message: string,
  options: { attemptAlreadyFenced?: boolean } = {},
): Promise<StartupInboxResubmitOutcome> {
  if (!await startupContextIsActive(context, options.attemptAlreadyFenced)) return 'unavailable';
  const copyMode = await paneCopyModeObservation(
    context.ownership.paneId,
    context.ownership.tmuxServerIdentity,
  );
  if (copyMode !== false) return 'unavailable';
  const observation = await capturePaneObservation(context.ownership.paneId, {
    operation: 'startup-submit-retry',
    ...(context.ownership.provider === 'tmux'
      ? { tmuxServerIdentity: context.ownership.tmuxServerIdentity }
      : {}),
  });
  if (!observation.ok || detectPaneTrustPromptKind(observation.captured, context.provider)) return 'unavailable';
  if (paneHasActiveTask(observation.captured, context.provider)) return 'pane_busy';
  if (!paneTailContainsLiteralLine(observation.captured, message)) return 'unavailable';
  try {
    await sendTeamPaneKey(context.ownership.paneId, 'Enter', context.ownership.tmuxServerIdentity);
    return 'resubmitted';
  } catch {
    return 'unavailable';
  }
}

export function shouldAttemptAdaptiveRetry(args: {
  paneBusy: boolean;
  latestCapture: string | null;
  message: string;
  paneInCopyMode: boolean;
  retriesAttempted: number;
}): boolean {
  if (process.env.OMC_TEAM_AUTO_INTERRUPT_RETRY === '0') return false;
  if (args.retriesAttempted >= 1) return false;
  if (args.paneInCopyMode) return false;
  if (!args.paneBusy) return false;
  if (typeof args.latestCapture !== 'string') return false;
  if (!paneTailContainsLiteralLine(args.latestCapture, args.message)) return false;
  if (paneHasActiveTask(args.latestCapture)) return false;
  if (!paneLooksReady(args.latestCapture)) return false;
  return true;
}

/**
 * Send a short trigger message to a worker via tmux send-keys.
 * Uses robust C-m double-press with delays to ensure the message is submitted.
 * Detects and auto-dismisses trust prompts. Handles busy panes with queue semantics.
 * Message must be < 200 chars.
 * Returns false on error (does not throw).
 */
export async function sendToWorker(
  _sessionName: string,
  paneId: string,
  message: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<boolean> {
  if (message.length > 200) {
    console.warn(`[tmux-session] sendToWorker: message rejected (${message.length} chars exceeds 200 char limit)`);
    return false;
  }
  if (!isCmuxSurfaceTarget(paneId) && !tmuxServerIdentity) return false;
  if (tmuxServerIdentity) {
    return guardedSendLiteralAndEnter(paneId, message, tmuxServerIdentity);
  }
  try {
    const sendKey = async (key: string) => {
      await sendTeamPaneKey(paneId, key);
    };

    // Guard: copy-mode captures keys; skip injection entirely.
    if (await paneInCopyMode(paneId)) {
      return false;
    }

    // Check for trust prompt and auto-dismiss before sending our text
    const initialCapture = await capturePaneAsync(paneId);
    if (paneHasClaudeStartupBanner(initialCapture)) {
      return false;
    }
    const paneBusy = paneHasActiveTask(initialCapture);

    const trustPromptKind = detectPaneTrustPromptKind(initialCapture);
    if (trustPromptKind === 'cursor_workspace_trust') {
      // Nothing to dismiss: cursor-agent printed the banner and exited. Sending
      // keys here would type into a dead pane.
      return false;
    }
    if (trustPromptKind === 'directory') {
      await sendKey('C-m');
      await sleep(120);
      await sendKey('C-m');
      await sleep(200);
    } else if (trustPromptKind === 'codex_hooks') {
      // Codex CLI 0.133+ may block on a hook-trust menu. Do not choose
      // "Trust all" automatically; select the safe non-trusting continuation
      // so non-interactive team workers can bootstrap without widening trust.
      await sendKey('3');
      await sleep(120);
      await sendKey('C-m');
      await sleep(200);
    }

    // Send text in literal mode with -- separator
    if (isCmuxSurfaceTarget(paneId)) {
      await cmuxSendSurface(paneId, message);
    } else {
      return false;
    }

    // Allow input buffer to settle
    await sleep(150);

    // Submit: up to 6 rounds of C-m double-press.
    // For busy panes, first round uses Tab+C-m (queue semantics).
    const submitRounds = 6;
    for (let round = 0; round < submitRounds; round++) {
      await sleep(100);
      if (round === 0 && paneBusy) {
        await sendKey('Tab');
        await sleep(80);
        await sendKey('C-m');
      } else {
        await sendKey('C-m');
        await sleep(200);
        await sendKey('C-m');
      }
      await sleep(140);

      // Check if text is still visible in the pane — if not, it was submitted
      const checkCapture = await capturePaneAsync(paneId);
      if (!paneTailContainsLiteralLine(checkCapture, message)) return true;

      await sleep(140);
    }

    // Safety gate: copy-mode can turn on while we retry; never send fallback control keys when active.
    if (await paneInCopyMode(paneId)) {
      return false;
    }

    // Adaptive fallback: for busy panes, retry once without interrupting active turns.
    const finalCapture = await capturePaneAsync(paneId);
    const paneModeBeforeAdaptiveRetry = await paneInCopyMode(paneId);
    if (shouldAttemptAdaptiveRetry({
      paneBusy,
      latestCapture: finalCapture,
      message,
      paneInCopyMode: paneModeBeforeAdaptiveRetry,
      retriesAttempted: 0,
    })) {
      if (await paneInCopyMode(paneId)) {
        return false;
      }
      await sendKey('C-u');
      await sleep(80);
      if (await paneInCopyMode(paneId)) {
        return false;
      }
      if (isCmuxSurfaceTarget(paneId)) {
        await cmuxSendSurface(paneId, message);
      } else {
        return false;
      }
      await sleep(120);
      for (let round = 0; round < 4; round++) {
        await sendKey('C-m');
        await sleep(180);
        await sendKey('C-m');
        await sleep(140);

        const retryCapture = await capturePaneAsync(paneId);
        if (!paneTailContainsLiteralLine(retryCapture, message)) return true;
      }
    }

    // Before fallback control keys, re-check copy-mode to avoid mutating scrollback UI state.
    if (await paneInCopyMode(paneId)) {
      return false;
    }

    // Fail-closed: one final submit attempt, then report failure so
    // callers can surface startup dispatch problems explicitly.
    await sendKey('C-m');
    await sleep(120);
    await sendKey('C-m');
    await sleep(140);
    const finalCheckCapture = await capturePaneAsync(paneId);
    // Empty capture means tmux capture failed or returned indeterminate output.
    // Treat this as delivery failure to keep dispatch behavior fail-closed.
    if (!finalCheckCapture || finalCheckCapture.trim() === '') {
      return false;
    }
    return !paneTailContainsLiteralLine(finalCheckCapture, message);
  } catch {
    return false;
  }
}

/**
 * Inject a status message into the leader Claude pane.
 * The message is typed into the leader's input, triggering a new conversation turn.
 * Prefixes with [OMC_TMUX_INJECT] marker to distinguish from user input.
 * Returns false on error (does not throw).
 */
export async function injectToLeaderPane(
  sessionName: string,
  leaderPaneId: string,
  message: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<boolean> {
  const prefixed = `[OMC_TMUX_INJECT] ${message}`.slice(0, 200);

  if (!isCmuxSurfaceTarget(leaderPaneId) && !tmuxServerIdentity) return false;
  if (tmuxServerIdentity) {
    return guardedSendLiteralAndEnter(leaderPaneId, prefixed, tmuxServerIdentity);
  }

  // If the leader is running a blocking tool (e.g. omc_run_team_wait shows
  // "esc to interrupt"), send C-c first so the message is not queued in the
  // stdin buffer behind the blocked process.
  try {
    if (await paneInCopyMode(leaderPaneId)) {
      return false;
    }
    const captured = await capturePaneAsync(leaderPaneId);
    if (paneHasActiveTask(captured)) {
      if (isCmuxSurfaceTarget(leaderPaneId)) {
        await cmuxSendSurfaceKey(leaderPaneId, 'C-c');
      } else {
        return false;
      }
      await new Promise<void>(r => setTimeout(r, 250));
    }
  } catch { /* best-effort */ }

  return sendToWorker(sessionName, leaderPaneId, prefixed);
}

/**
 * Check if a worker pane is still alive.
 * Uses pane ID for stable targeting (not pane index).
 */
export type WorkerPaneLiveness = 'alive' | 'dead' | 'unknown';

function isTmuxPaneNotFoundError(error: unknown): boolean {
  const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown } | null | undefined;
  const text = [err?.stderr, err?.stdout, err?.message]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
  return /can't find pane|can't find window|can't find session|no such pane|pane not found|unknown pane/.test(text);
}

export async function getWorkerLiveness(paneId: string): Promise<WorkerPaneLiveness> {
  if (isCmuxSurfaceTarget(paneId)) {
    try {
      await cmuxCaptureSurface(paneId);
      return 'alive';
    } catch {
      return 'unknown';
    }
  }
  if (!TMUX_MAILBOX_PANE_ID.test(paneId)) return 'unknown';

  try {
    const result = await tmuxCmdAsync([
      'display-message', '-t', paneId, '-p', '#{pane_dead}'
    ]);
    // tmux emits one exact state value. Empty, multi-line, or otherwise
    // malformed output is not evidence that the pane is dead. Fall through
    // to the complete native-pane inventory for those outputs.
    const state = result.stdout.replace(/\r?\n$/, '');
    if (state === '0') return 'alive';
    if (state === '1') return 'dead';
    return getTmuxPaneLivenessFromInventory(paneId);
  } catch (error) {
    return isTmuxPaneNotFoundError(error) ? 'dead' : 'unknown';
  }
}

async function getWorkerLivenessAtTmuxIdentity(
  paneId: string,
  identity: TmuxServerIdentity,
): Promise<WorkerPaneLiveness> {
  if (!isValidTmuxServerIdentity(identity) || !TMUX_MAILBOX_PANE_ID.test(paneId)) return 'unknown';
  try {
    const result = await tmuxCmdAsync(
      tmuxArgsForIdentity(identity, ['display-message', '-t', paneId, '-p', '#{pane_dead}']),
      { timeout: 2_000, stripTmux: true },
    );
    if (result.stderr.trim()) return 'unknown';
    const afterState = await observeTmuxServerIdentity(identity);
    if (afterState === 'dead') return 'dead';
    if (afterState !== 'matching') return 'unknown';
    const state = result.stdout.replace(/\r?\n$/, '');
    if (state === '0') return 'alive';
    if (state === '1') return 'dead';
    return getTmuxPaneLivenessFromInventory(paneId, identity);
  } catch (error) {
    return isTmuxPaneNotFoundError(error) ? 'dead' : 'unknown';
  }
}

/**
 * Liveness bound to the original tmux server. A positively dead original
 * process means its panes are absent without querying a replacement server.
 */
export async function getOwnedWorkerLiveness(
  ownership: WorkerPaneOwnership,
): Promise<WorkerPaneLiveness> {
  if (ownership.provider === 'cmux') return getWorkerLiveness(ownership.paneId);
  if (!isValidTmuxServerIdentity(ownership.tmuxServerIdentity)) return 'unknown';
  const serverState = await observeTmuxServerIdentity(ownership.tmuxServerIdentity);
  if (serverState === 'dead') return 'dead';
  if (serverState !== 'matching') return 'unknown';
  return getWorkerLivenessAtTmuxIdentity(ownership.paneId, ownership.tmuxServerIdentity);
}

export async function isWorkerAlive(paneId: string): Promise<boolean> {
  return (await getWorkerLiveness(paneId)) === 'alive';
}

function isPaneId(value: string | undefined): value is string {
  return typeof value === 'string' && (/^%\d+$/.test(value.trim()) || isCmuxSurfaceTarget(value));
}

function dedupeWorkerPaneIds(paneIds: Array<string | undefined>, leaderPaneId?: string): string[] {
  const unique = new Set<string>();
  for (const paneId of paneIds) {
    if (!isPaneId(paneId)) continue;
    const normalized = paneId.trim();
    if (normalized === leaderPaneId) continue;
    unique.add(normalized);
  }
  return [...unique];
}

interface TmuxSessionRecord {
  id: string;
  name: string;
}

interface TmuxWindowRecord {
  id: string;
  sessionId: string;
  sessionName: string;
  index: string;
}

interface TmuxPaneRecord {
  id: string;
  dead: '0' | '1';
}

/**
 * Split provider query output only when it contains at least one complete,
 * non-empty line. An empty response is deliberately unknown: it could mean
 * that the query failed before producing output.
 */
function parseTmuxQueryLines(output: string): string[] | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length || lines.some(line => line.length === 0)) return null;
  return lines;
}

function parseTmuxSessionRecords(output: string): TmuxSessionRecord[] | null {
  const lines = parseTmuxQueryLines(output);
  if (!lines) return null;

  const records: TmuxSessionRecord[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^(\$\d+)\t([^\t\r\n]+)$/);
    if (!match) return null;
    const [, id, name] = match;
    if (!id || !name || ids.has(id) || names.has(name)) return null;
    ids.add(id);
    names.add(name);
    records.push({ id, name });
  }
  return records;
}

function parseTmuxPaneRecords(output: string): TmuxPaneRecord[] | null {
  const lines = parseTmuxQueryLines(output);
  if (!lines) return null;

  const records: TmuxPaneRecord[] = [];
  const ids = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^(%\d+) ([01])$/);
    if (!match) return null;
    const [, id, dead] = match;
    if (!id || !dead || ids.has(id)) return null;
    ids.add(id);
    records.push({ id, dead: dead as '0' | '1' });
  }
  return records;
}

async function getTmuxPaneLivenessFromInventory(
  paneId: string,
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<WorkerPaneLiveness> {
  if (tmuxServerIdentity) {
    const beforeState = await observeTmuxServerIdentity(tmuxServerIdentity);
    if (beforeState === 'dead') return 'dead';
    if (beforeState !== 'matching') return 'unknown';
  }
  try {
    const args = [
      'list-panes', '-a', '-F', '#{pane_id} #{pane_dead}',
    ];
    const result = await tmuxCmdAsync(
      tmuxServerIdentity ? tmuxArgsForIdentity(tmuxServerIdentity, args) : args,
      tmuxServerIdentity ? { timeout: 2_000, stripTmux: true } : undefined,
    );
    if (result.stderr.trim()) return 'unknown';
    if (tmuxServerIdentity) {
      const afterState = await observeTmuxServerIdentity(tmuxServerIdentity);
      if (afterState === 'dead') return 'dead';
      if (afterState !== 'matching') return 'unknown';
    }
    const panes = parseTmuxPaneRecords(result.stdout);
    if (!panes) return 'unknown';
    const matches = panes.filter(pane => pane.id === paneId);
    if (matches.length > 1) return 'unknown';
    const pane = matches[0];
    if (!pane) {
      // A valid, complete non-empty inventory proves the exact native pane is
      // absent. Never infer this from an empty or malformed response.
      return 'dead';
    }
    return pane.dead === '0' ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

function parseTmuxWindowRecords(output: string): TmuxWindowRecord[] | null {
  const lines = parseTmuxQueryLines(output);
  if (!lines) return null;

  const records: TmuxWindowRecord[] = [];
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^(@\d+)\t(\$\d+)\t([^\t\r\n]+)\t(\d+)$/);
    if (!match) return null;
    const [, id, sessionId, sessionName, index] = match;
    const target = `${sessionName}:${index}`;
    if (!id || !sessionId || !sessionName || !index || ids.has(id) || targets.has(target)) {
      return null;
    }
    ids.add(id);
    targets.add(target);
    records.push({ id, sessionId, sessionName, index });
  }
  return records;
}

async function listTmuxSessionsForCleanup(
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<TmuxSessionRecord[] | null> {
  try {
    const args = [
      'list-sessions', '-F', '#{session_id}\t#{session_name}',
    ];
    const result = await tmuxCmdAsync(
      tmuxServerIdentity ? tmuxArgsForIdentity(tmuxServerIdentity, args) : args,
      tmuxServerIdentity ? { timeout: 2_000, stripTmux: true } : undefined,
    );
    if (result.stderr.trim()) return null;
    return parseTmuxSessionRecords(result.stdout);
  } catch {
    return null;
  }
}

async function listTmuxWindowsForCleanup(
  tmuxServerIdentity?: TmuxServerIdentity,
): Promise<TmuxWindowRecord[] | null> {
  try {
    // Query every session rather than targeting the caller-provided name:
    // tmux target names accept unique prefixes, which could otherwise resolve
    // an unrelated similarly named session before we can validate ownership.
    const args = [
      'list-windows', '-a', '-F', '#{window_id}\t#{session_id}\t#{session_name}\t#{window_index}',
    ];
    const result = await tmuxCmdAsync(
      tmuxServerIdentity ? tmuxArgsForIdentity(tmuxServerIdentity, args) : args,
      tmuxServerIdentity ? { timeout: 2_000, stripTmux: true } : undefined,
    );
    if (result.stderr.trim()) return null;
    return parseTmuxWindowRecords(result.stdout);
  } catch {
    return null;
  }
}

function parseDedicatedWindowTarget(
  sessionName: string,
): { sessionName: string; windowIndex: string } | null {
  const separator = sessionName.indexOf(':');
  if (separator <= 0 || separator === sessionName.length - 1) return null;
  if (sessionName.indexOf(':', separator + 1) !== -1) return null;
  const targetSession = sessionName.slice(0, separator);
  const rawIndex = sessionName.slice(separator + 1);
  if (!/^\d+$/.test(rawIndex)) return null;
  const numericIndex = Number(rawIndex);
  if (!Number.isSafeInteger(numericIndex)) return null;
  return { sessionName: targetSession, windowIndex: String(numericIndex) };
}

/**
 * Normalize only the response form published for a detached session.  A
 * detached `new-session -P` record is represented as `session:0`, while
 * session inventory stores the native session name without a window suffix.
 * Split/dedicated-window callers must not use this normalization.
 */
export function normalizeDetachedSessionTarget(sessionName: string): string | null {
  const detachedTarget = sessionName.includes(':')
    ? parseDedicatedWindowTarget(sessionName)
    : null;
  const sessionTarget = detachedTarget
    ? detachedTarget.windowIndex === '0' ? detachedTarget.sessionName : ''
    : sessionName;
  return sessionTarget && /^[^\s:]+$/.test(sessionTarget) ? sessionTarget : null;
}

export async function resolveSplitPaneWorkerPaneIds(
  _sessionName: string,
  recordedPaneIds?: string[],
  leaderPaneId?: string,
): Promise<string[]> {
  return dedupeWorkerPaneIds(recordedPaneIds ?? [], leaderPaneId);
}

export type TeamSessionTargetPresence =
  | { kind: 'owned' }
  | { kind: 'absent' }
  | { kind: 'present_unowned' }
  | { kind: 'unknown' };

/**
 * Observe whether the recorded team session/window still belongs to this
 * incarnation. Absence is a positive cleanup proof; a still-present target
 * without the recorded leader pane is not.
 */
export async function observeTeamSessionTargetPresence(args: {
  sessionName: string;
  sessionMode: Exclude<TeamSessionMode, 'split-pane'>;
  leaderPaneId: string;
  tmuxServerIdentity?: TmuxServerIdentity;
}): Promise<TeamSessionTargetPresence> {
  const provider = args.sessionName.startsWith('cmux:') ? 'cmux' as const : 'tmux' as const;
  if (provider === 'tmux') {
    if (!isValidTmuxServerIdentity(args.tmuxServerIdentity)) return { kind: 'unknown' };
    const serverState = await observeTmuxServerIdentity(args.tmuxServerIdentity);
    if (serverState === 'dead') return { kind: 'absent' };
    if (serverState !== 'matching') return { kind: 'unknown' };
  }

  const ownership = await verifyTeamTargetOwnership({
    provider,
    providerTarget: args.sessionName,
    recipient: 'leader-fixed',
    recipientRole: 'leader',
    paneId: args.leaderPaneId,
    ...(provider === 'tmux' ? { tmuxServerIdentity: args.tmuxServerIdentity } : {}),
  } as MailboxNotificationTarget);
  if (ownership.kind === 'owned') return { kind: 'owned' };
  if (provider !== 'tmux' || !isValidTmuxServerIdentity(args.tmuxServerIdentity)) {
    return { kind: 'unknown' };
  }

  if (args.sessionMode === 'dedicated-window') {
    const target = parseDedicatedWindowTarget(args.sessionName);
    if (!target) return { kind: 'unknown' };
    const windows = await listTmuxWindowsForCleanup(args.tmuxServerIdentity);
    if (!windows) return { kind: 'unknown' };
    const matches = windows.filter(window =>
      window.sessionName === target.sessionName && window.index === target.windowIndex,
    );
    if (matches.length > 1) return { kind: 'unknown' };
    return matches.length === 0 ? { kind: 'absent' } : { kind: 'present_unowned' };
  }

  const sessionTarget = normalizeDetachedSessionTarget(args.sessionName);
  if (!sessionTarget) return { kind: 'unknown' };
  const sessions = await listTmuxSessionsForCleanup(args.tmuxServerIdentity);
  if (!sessions) return { kind: 'unknown' };
  const matches = sessions.filter(session => session.name === sessionTarget);
  if (matches.length > 1) return { kind: 'unknown' };
  return matches.length === 0 ? { kind: 'absent' } : { kind: 'present_unowned' };
}

/**
 * Kill the team tmux session or just the worker panes, depending on how the
 * team was created.
 *
 * - split-pane: kill only worker panes; preserve the leader pane and user window.
 * - dedicated-window: kill the owned tmux window.
 * - detached-session: kill the fully owned tmux session.
 */
export async function killTeamSession(
  sessionName: string,
  workerPaneIds?: string[],
  leaderPaneId?: string,
  options: { sessionMode?: TeamSessionMode; tmuxServerIdentity?: TmuxServerIdentity } = {},
): Promise<boolean> {
  const sessionMode = options.sessionMode
    ?? (sessionName.includes(':') ? 'split-pane' : 'detached-session');
  const provider = sessionName.startsWith('cmux:') ? 'cmux' as const : 'tmux' as const;
  const identity = options.tmuxServerIdentity;

  if (provider === 'tmux') {
    if (!isValidTmuxServerIdentity(identity)) return false;
    const serverState = await observeTmuxServerIdentity(identity);
    // Positive death of the original server proves all resources from that
    // incarnation absent; never query the replacement server by name.
    if (serverState === 'dead') return true;
    if (serverState !== 'matching') return false;
  }

  if (sessionMode === 'split-pane') {
    // Missing/empty pane evidence is NOT successful cleanup — callers must
    // supply validated pane identities or treat cleanup as incomplete.
    if (!workerPaneIds?.length) return false;
    let cleaned = true;
    for (const id of workerPaneIds) {
      if (id === leaderPaneId) continue;
      try {
        if (provider === 'tmux' && !TMUX_MAILBOX_PANE_ID.test(id)) {
          cleaned = false;
          continue;
        }
        const membership = await verifyTeamTargetOwnership({
          provider,
          providerTarget: sessionName,
          recipient: 'worker',
          recipientRole: 'worker',
          paneId: id,
          ...(provider === 'tmux' ? { tmuxServerIdentity: identity } : {}),
        } as MailboxNotificationTarget);
        if (membership.kind !== 'owned') { cleaned = false; continue; }
        if (provider === 'cmux') await cmuxCloseSurface(id);
        else {
          const result = await runGuardedNativeTmuxCommand(
            identity!,
            tmuxCommandString(['kill-pane', '-t', id]),
          );
          if (result.outcome !== 'executed') {
            const state = await observeTmuxServerIdentity(identity!);
            if (state !== 'dead') cleaned = false;
          }
        }
      } catch {
        cleaned = false;
      }
    }
    return cleaned;
  }

  if (sessionMode === 'dedicated-window') {
    const target = parseDedicatedWindowTarget(sessionName);
    if (!target) return false;

    const windows = await listTmuxWindowsForCleanup(identity);
    if (!windows) return false;
    const matches = windows.filter(window =>
      window.sessionName === target.sessionName && window.index === target.windowIndex,
    );
    if (matches.length > 1) return false;
    const window = matches[0];
    if (!window) {
      // A valid, non-empty inventory proves that the exact target is absent.
      return true;
    }

    const result = await runGuardedNativeTmuxCommand(
      identity!,
      tmuxCommandString(['kill-window', '-t', window.id]),
    );
    if (result.outcome === 'executed') return true;
    // A failed guard may race with original-server death; only that positive
    // process evidence authorizes treating the old window as absent.
    return await observeTmuxServerIdentity(identity!) === 'dead';
  }

  // Detached creation publishes `session:0` because the creating response
  // includes its window resource. Normalize that validated zero-window form
  // to the native session target before inventory resolution; never strip an
  // arbitrary suffix or fall back to a name lookup on another server.
  const sessionTarget = normalizeDetachedSessionTarget(sessionName);
  if (!sessionTarget) return false;
  if (process.env.OMC_TEAM_ALLOW_KILL_CURRENT_SESSION !== '1' && process.env.TMUX) {
    try {
      const current = await tmuxCmdAsync(
        tmuxArgsForIdentity(identity!, ['display-message', '-p', '#S']),
        { timeout: 2_000, stripTmux: true },
      );
      const currentLines = parseTmuxQueryLines(current.stdout);
      if (!currentLines || currentLines.length !== 1) return false;
      const currentSessionName = currentLines[0];
      if (currentSessionName === sessionTarget) return false;
    } catch {
      return false;
    }
  }

  const sessions = await listTmuxSessionsForCleanup(identity);
  if (!sessions) return false;
  const matches = sessions.filter(session => session.name === sessionTarget);
  if (matches.length > 1) return false;
  const session = matches[0];
  if (!session) {
    // A valid, non-empty inventory proves that the exact target is absent.
    return true;
  }

  const result = await runGuardedNativeTmuxCommand(
    identity!,
    tmuxCommandString(['kill-session', '-t', session.id]),
  );
  if (result.outcome === 'executed') return true;
  return await observeTmuxServerIdentity(identity!) === 'dead';
}
