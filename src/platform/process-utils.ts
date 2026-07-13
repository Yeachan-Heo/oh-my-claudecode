/**
 * Cross-Platform Process Utilities
 * Provides unified process management across Windows, macOS, and Linux.
 */

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import * as fsPromises from 'fs/promises';

const execFileAsync = promisify(execFile);

function remainingDeadlineMs(deadlineAt?: number): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(0, deadlineAt - Date.now());
}

function isDeadlineExceeded(deadlineAt?: number): boolean {
  return deadlineAt !== undefined && remainingDeadlineMs(deadlineAt) === 0;
}

function parseDeadline(deadlineAt: string): number | undefined {
  const value = Date.parse(deadlineAt);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Kill a process and optionally its entire process tree.
 *
 * On Windows: Uses taskkill /T for tree kill, /F for force
 * On Unix: Uses negative PID for process group, falls back to direct kill
 */
export async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === 'win32') {
    return killProcessTreeWindows(pid, signal === 'SIGKILL');
  } else {
    return killProcessTreeUnix(pid, signal);
  }
}

async function killProcessTreeWindows(pid: number, force: boolean): Promise<boolean> {
  try {
    const args = ['/T', '/PID', String(pid)];
    if (force) {
      args.unshift('/F');
    }
    execFileSync('taskkill.exe', args, {
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true
    });
    return true;
  } catch (err: unknown) {
    const error = err as { status?: number };
    if (error.status === 128) return true;
    return false;
  }
}

function killProcessTreeUnix(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Check if a process is alive.
 * Works cross-platform by attempting signal 0.
 * EPERM means the process exists but we lack permission to signal it.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * Get process start time for PID reuse detection.
 * Returns milliseconds timestamp on macOS/Windows, jiffies on Linux.
 */
export async function getProcessStartTime(pid: number, deadlineAt?: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0 || isDeadlineExceeded(deadlineAt)) return undefined;

  if (process.platform === 'win32') {
    return getProcessStartTimeWindows(pid, deadlineAt);
  } else if (process.platform === 'darwin') {
    return getProcessStartTimeMacOS(pid, deadlineAt);
  } else if (process.platform === 'linux') {
    return getProcessStartTimeLinux(pid, deadlineAt);
  }
  return undefined;
}

async function getProcessStartTimeWindows(pid: number, deadlineAt?: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('wmic', [
      'process', 'where', `ProcessId=${pid}`,
      'get', 'CreationDate', '/format:csv'
    ], { timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true });

    const wmicTime = parseWmicCreationDate(stdout);
    if (wmicTime !== undefined) return wmicTime;
  } catch {
    // WMIC is deprecated on newer Windows builds; fall back to PowerShell.
  }

  if (isDeadlineExceeded(deadlineAt)) return undefined;
  const cimTime = await getProcessStartTimeWindowsPowerShellCim(pid, deadlineAt);
  if (cimTime !== undefined) return cimTime;

  return isDeadlineExceeded(deadlineAt)
    ? undefined
    : getProcessStartTimeWindowsPowerShellProcess(pid, deadlineAt);
}

function parseWmicCreationDate(stdout: string): number | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return undefined;

  const candidate = lines.find(line => /,\d{14}/.test(line)) ?? lines[1];
  const match = candidate.match(/,(\d{14})/);
  if (!match) return undefined;

  const d = match[1];
  const date = new Date(
    parseInt(d.slice(0, 4), 10),
    parseInt(d.slice(4, 6), 10) - 1,
    parseInt(d.slice(6, 8), 10),
    parseInt(d.slice(8, 10), 10),
    parseInt(d.slice(10, 12), 10),
    parseInt(d.slice(12, 14), 10)
  );

  const value = date.getTime();
  return Number.isNaN(value) ? undefined : value;
}

function parseWindowsEpochMilliseconds(stdout: string): number | undefined {
  const match = stdout.trim().match(/-?\d+/);
  if (!match) return undefined;
  const value = parseInt(match[0], 10);
  return Number.isFinite(value) ? value : undefined;
}

async function getProcessStartTimeWindowsPowerShellCim(pid: number, deadlineAt?: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if ($p -and $p.CreationDate) { [DateTimeOffset]$p.CreationDate | ForEach-Object { $_.ToUnixTimeMilliseconds() } }`
      ],
      { timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true }
    );
    return parseWindowsEpochMilliseconds(stdout);
  } catch {
    return undefined;
  }
}

async function getProcessStartTimeWindowsPowerShellProcess(pid: number, deadlineAt?: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.StartTime) { [DateTimeOffset]$p.StartTime | ForEach-Object { $_.ToUnixTimeMilliseconds() } }`
      ],
      { timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true }
    );
    return parseWindowsEpochMilliseconds(stdout);
  } catch {
    return undefined;
  }
}

async function getProcessStartTimeMacOS(pid: number, deadlineAt?: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C' },
      timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)),
      windowsHide: true
    });
    const date = new Date(stdout.trim());
    return isNaN(date.getTime()) ? undefined : date.getTime();
  } catch {
    return undefined;
  }
}

async function getProcessStartTimeLinux(pid: number, deadlineAt?: number): Promise<number | undefined> {
  if (isDeadlineExceeded(deadlineAt)) return undefined;
  try {
    const stat = await fsPromises.readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return undefined;

    const fields = stat.substring(closeParen + 2).split(' ');
    const startTime = parseInt(fields[19], 10);
    return isNaN(startTime) ? undefined : startTime;
  } catch {
    return undefined;
  }
}

/**
 * Gracefully terminate a process with escalation.
 */
export async function gracefulKill(
  pid: number,
  gracePeriodMs: number = 5000
): Promise<'graceful' | 'forced' | 'failed'> {
  if (!isProcessAlive(pid)) return 'graceful';

  await killProcessTree(pid, 'SIGTERM');

  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return 'graceful';
    await new Promise(r => setTimeout(r, 100));
  }

  await killProcessTree(pid, 'SIGKILL');

  await new Promise(r => setTimeout(r, 1000));
  return isProcessAlive(pid) ? 'failed' : 'forced';
}

/** Stable PID-reuse identity suitable for a durable worker manifest. */
export async function getProcessStartIdentity(pid: number, deadlineAt?: number): Promise<string | null> {
  const startTime = await getProcessStartTime(pid, deadlineAt);
  return startTime === undefined || isDeadlineExceeded(deadlineAt) ? null : String(startTime);
}

export async function isProcessIdentityLive(
  pid: number,
  expectedStartIdentity: string,
  deadlineAt?: number,
): Promise<'live' | 'dead' | 'mismatch' | 'unknown'> {
  if (!Number.isInteger(pid) || pid <= 0 || !expectedStartIdentity || isDeadlineExceeded(deadlineAt)) {
    return isDeadlineExceeded(deadlineAt) ? 'unknown' : 'dead';
  }
  if (!isProcessAlive(pid)) return 'dead';

  const identity = await getProcessStartIdentity(pid, deadlineAt);
  if (identity === null) return isProcessAlive(pid) ? 'unknown' : 'dead';
  return identity === expectedStartIdentity ? 'live' : 'mismatch';
}

export interface TerminateOwnedProcessTreeOptions {
  pid: number;
  expectedStartIdentity: string;
  deadlineAt: string;
  force?: boolean;
}

/**
 * Terminate only a process whose durable start identity still matches. The
 * Windows path is asynchronous and receives the worker's remaining deadline,
 * preventing taskkill from holding SessionEnd for its legacy five seconds.
 */
export async function terminateOwnedProcessTree(
  options: TerminateOwnedProcessTreeOptions,
): Promise<'terminated' | 'already-dead' | 'identity-mismatch' | 'unknown' | 'deadline-exceeded'> {
  const deadline = parseDeadline(options.deadlineAt);
  if (deadline === undefined || isDeadlineExceeded(deadline)) return 'deadline-exceeded';

  const liveness = await isProcessIdentityLive(options.pid, options.expectedStartIdentity, deadline);
  if (liveness === 'dead') return 'already-dead';
  if (liveness === 'mismatch') return 'identity-mismatch';
  if (liveness === 'unknown') {
    return isDeadlineExceeded(deadline) ? 'deadline-exceeded' : 'unknown';
  }
  if (isDeadlineExceeded(deadline)) return 'deadline-exceeded';

  if (process.platform !== 'win32') {
    return killProcessTreeUnix(options.pid, options.force ? 'SIGKILL' : 'SIGTERM')
      ? 'terminated'
      : (isProcessAlive(options.pid) ? 'unknown' : 'already-dead');
  }

  const timeout = remainingDeadlineMs(deadline);
  if (!timeout) return 'deadline-exceeded';
  try {
    const args = ['/T', '/PID', String(options.pid)];
    if (options.force) args.unshift('/F');
    await execFileAsync('taskkill.exe', args, { windowsHide: true, timeout });
    return 'terminated';
  } catch (error: unknown) {
    if (isDeadlineExceeded(deadline)) return 'deadline-exceeded';
    const status = (error as { status?: number }).status;
    if (status === 128 || !isProcessAlive(options.pid)) return 'already-dead';
    return 'unknown';
  }
}
