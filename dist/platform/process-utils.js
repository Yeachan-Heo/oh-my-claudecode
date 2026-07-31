/**
 * Cross-Platform Process Utilities
 * Provides unified process management across Windows, macOS, and Linux.
 */
import { execFileSync, execFile, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';
import * as fsPromises from 'fs/promises';
const execFileAsync = promisify(execFile);
function processGroupIdSync(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    if (process.platform === 'linux') {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const closeParen = stat.lastIndexOf(')');
            if (closeParen === -1)
                return null;
            const fields = stat.substring(closeParen + 2).split(' ');
            const group = Number(fields[2]);
            return Number.isInteger(group) && group > 0 ? group : null;
        }
        catch {
            return null;
        }
    }
    if (process.platform === 'darwin') {
        try {
            const result = spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], {
                encoding: 'utf8', timeout: 2000, windowsHide: true,
            });
            const group = Number(result.stdout?.trim());
            return result.status === 0 && Number.isInteger(group) && group > 0 ? group : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Capture creation-bound POSIX process-group metadata for a detached owner. */
export function captureOwnedProcessGroup(pid) {
    if (process.platform === 'win32')
        return null;
    const processStartIdentity = getProcessStartIdentitySync(pid);
    const processGroupId = processGroupIdSync(pid);
    if (!processStartIdentity || processGroupId === null)
        return null;
    return { pid, processStartIdentity, processGroupId };
}
/** Signal only an exact-identity POSIX process-group leader; never fall back to PID. */
export async function terminateOwnedProcessGroup(options) {
    const deadline = parseDeadline(options.deadlineAt);
    if (deadline === undefined || isDeadlineExceeded(deadline))
        return 'deadline-exceeded';
    if (process.platform === 'win32')
        return 'unknown';
    if (!Number.isInteger(options.processGroupId) || options.processGroupId <= 0)
        return 'unknown';
    if (!isProcessAlive(options.pid))
        return 'already-dead';
    const identity = getProcessStartIdentitySync(options.pid);
    const group = processGroupIdSync(options.pid);
    if (!identity || !group)
        return 'unknown';
    if (identity !== options.expectedStartIdentity || group !== options.processGroupId)
        return 'identity-mismatch';
    if (isDeadlineExceeded(deadline))
        return 'deadline-exceeded';
    try {
        process.kill(-options.processGroupId, options.force ? 'SIGKILL' : 'SIGTERM');
        return 'terminated';
    }
    catch (error) {
        const code = error.code;
        if (code === 'ESRCH')
            return isProcessAlive(options.pid) ? 'unknown' : 'already-dead';
        return 'unknown';
    }
}
function remainingDeadlineMs(deadlineAt) {
    if (deadlineAt === undefined)
        return undefined;
    return Math.max(0, deadlineAt - Date.now());
}
function isDeadlineExceeded(deadlineAt) {
    return deadlineAt !== undefined && remainingDeadlineMs(deadlineAt) === 0;
}
function parseDeadline(deadlineAt) {
    const value = Date.parse(deadlineAt);
    return Number.isFinite(value) ? value : undefined;
}
/**
 * Kill a process and optionally its entire process tree.
 *
 * On Windows: Uses taskkill /T for generic callers; this is not creation-bound
 * and MUST NOT be used for launch-owned cleanup.
 * On Unix: Signals the owned process group, falling back to the root PID.
 */
export async function killProcessTree(pid, signal = 'SIGTERM') {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    if (process.platform === 'win32') {
        return killProcessTreeWindows(pid, signal === 'SIGKILL');
    }
    else {
        return killProcessTreeUnix(pid, signal);
    }
}
async function killProcessTreeWindows(pid, force) {
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
    }
    catch (err) {
        const error = err;
        if (error.status === 128)
            return true;
        return false;
    }
}
function killProcessTreeUnix(pid, signal) {
    try {
        process.kill(-pid, signal);
        return true;
    }
    catch {
        try {
            process.kill(pid, signal);
            return true;
        }
        catch {
            return !isProcessAlive(pid);
        }
    }
}
/**
 * Check if a process is alive.
 * Works cross-platform by attempting signal 0.
 * EPERM means the process exists but we lack permission to signal it.
 */
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
            return true;
        }
        return false;
    }
}
/**
 * Get process start time for PID reuse detection.
 * Returns milliseconds timestamp on macOS/Windows, jiffies on Linux.
 */
export async function getProcessStartTime(pid, deadlineAt) {
    if (!Number.isInteger(pid) || pid <= 0 || isDeadlineExceeded(deadlineAt))
        return undefined;
    if (process.platform === 'win32') {
        return getProcessStartTimeWindows(pid, deadlineAt);
    }
    else if (process.platform === 'darwin') {
        return getProcessStartTimeMacOS(pid, deadlineAt);
    }
    else if (process.platform === 'linux') {
        return getProcessStartTimeLinux(pid, deadlineAt);
    }
    return undefined;
}
async function getProcessStartTimeWindows(pid, deadlineAt) {
    try {
        const { stdout } = await execFileAsync('wmic', [
            'process', 'where', `ProcessId=${pid}`,
            'get', 'CreationDate', '/format:csv'
        ], { timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true });
        const wmicTime = parseWmicCreationDate(stdout);
        if (wmicTime !== undefined)
            return wmicTime;
    }
    catch {
        // WMIC is deprecated on newer Windows builds; fall back to PowerShell.
    }
    if (isDeadlineExceeded(deadlineAt))
        return undefined;
    const cimTime = await getProcessStartTimeWindowsPowerShellCim(pid, deadlineAt);
    if (cimTime !== undefined)
        return cimTime;
    return isDeadlineExceeded(deadlineAt)
        ? undefined
        : getProcessStartTimeWindowsPowerShellProcess(pid, deadlineAt);
}
function parseWmicCreationDate(stdout) {
    const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2)
        return undefined;
    const candidate = lines.find(line => /,\d{14}/.test(line)) ?? lines[1];
    const match = candidate.match(/,(\d{14})/);
    if (!match)
        return undefined;
    const d = match[1];
    const date = new Date(parseInt(d.slice(0, 4), 10), parseInt(d.slice(4, 6), 10) - 1, parseInt(d.slice(6, 8), 10), parseInt(d.slice(8, 10), 10), parseInt(d.slice(10, 12), 10), parseInt(d.slice(12, 14), 10));
    const value = date.getTime();
    return Number.isNaN(value) ? undefined : value;
}
function parseWindowsEpochMilliseconds(stdout) {
    const match = stdout.trim().match(/-?\d+/);
    if (!match)
        return undefined;
    const value = parseInt(match[0], 10);
    return Number.isFinite(value) ? value : undefined;
}
async function getProcessStartTimeWindowsPowerShellCim(pid, deadlineAt) {
    try {
        const { stdout } = await execFileAsync('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if ($p -and $p.CreationDate) { [DateTimeOffset]$p.CreationDate | ForEach-Object { $_.ToUnixTimeMilliseconds() } }`
        ], { timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true });
        return parseWindowsEpochMilliseconds(stdout);
    }
    catch {
        return undefined;
    }
}
async function getProcessStartTimeWindowsPowerShellProcess(pid, deadlineAt) {
    try {
        const { stdout } = await execFileAsync('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.StartTime) { [DateTimeOffset]$p.StartTime | ForEach-Object { $_.ToUnixTimeMilliseconds() } }`
        ], { timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true });
        return parseWindowsEpochMilliseconds(stdout);
    }
    catch {
        return undefined;
    }
}
async function getProcessStartTimeMacOS(pid, deadlineAt) {
    try {
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
            env: { ...process.env, LC_ALL: 'C' },
            timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)),
            windowsHide: true
        });
        const date = new Date(stdout.trim());
        return isNaN(date.getTime()) ? undefined : date.getTime();
    }
    catch {
        return undefined;
    }
}
async function getProcessStartTimeLinux(pid, deadlineAt) {
    if (isDeadlineExceeded(deadlineAt))
        return undefined;
    try {
        const stat = await fsPromises.readFile(`/proc/${pid}/stat`, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        if (closeParen === -1)
            return undefined;
        const fields = stat.substring(closeParen + 2).split(' ');
        const startTime = parseInt(fields[19], 10);
        return isNaN(startTime) ? undefined : startTime;
    }
    catch {
        return undefined;
    }
}
/**
 * Synchronous process start identity capture for use immediately after spawn,
 * before the event loop turns. Closes the PID-reuse window that an async
 * getProcessStartIdentity call would leave open.
 *
 * - Linux: reads /proc/<pid>/stat synchronously (microseconds).
 * - macOS: spawnSync('ps', ...) to get the process start time.
 * - Windows: spawnSync('powershell', ...) to get StartTime ticks.
 *
 * Returns null if the identity cannot be captured synchronously. The caller
 * must fail closed (no signal) when this returns null.
 */
export function getProcessStartIdentitySync(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    if (process.platform === 'linux') {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const closeParen = stat.lastIndexOf(')');
            if (closeParen === -1)
                return null;
            const fields = stat.substring(closeParen + 2).split(' ');
            const startTime = parseInt(fields[19] ?? '', 10);
            return Number.isNaN(startTime) ? null : String(startTime);
        }
        catch {
            return null;
        }
    }
    if (process.platform === 'darwin') {
        try {
            const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, windowsHide: true });
            if (result.status !== 0 || !result.stdout)
                return null;
            const time = new Date(result.stdout.trim()).getTime();
            return Number.isNaN(time) ? null : String(time);
        }
        catch {
            return null;
        }
    }
    if (process.platform === 'win32') {
        try {
            const cmd = `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`;
            const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 3000, windowsHide: true });
            if (result.status !== 0 || !result.stdout)
                return null;
            const ticks = result.stdout.trim().match(/^\d+$/)?.[0];
            return ticks ? `ticks:${ticks}` : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
/**
 * Gracefully terminate a process with escalation.
 */
export async function gracefulKill(pid, gracePeriodMs = 5000) {
    if (!isProcessAlive(pid))
        return 'graceful';
    await killProcessTree(pid, 'SIGTERM');
    const deadline = Date.now() + gracePeriodMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid))
            return 'graceful';
        await new Promise(r => setTimeout(r, 100));
    }
    await killProcessTree(pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 1000));
    return isProcessAlive(pid) ? 'failed' : 'forced';
}
/** Convert a WMIC/CIM DMTF datetime to .NET ticks for a single Windows identity format. */
export function dmtfCreationDateToTicks(dmtf) {
    // DMTF: yyyyMMddHHmmss.ffffff+UUU (offset minutes; six fractional digits = microseconds)
    const m = dmtf.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/);
    if (!m)
        return null;
    const [, ys, mo, ds, hs, mins, ss, us, sign, off] = m;
    const year = Number(ys), month = Number(mo), day = Number(ds);
    const hour = Number(hs), minute = Number(mins), second = Number(ss);
    const micros = Number(us);
    const offsetMin = Number(off) * (sign === '-' ? -1 : 1);
    if (![year, month, day, hour, minute, second, micros, offsetMin].every(Number.isFinite))
        return null;
    // Strict ranges — do not let JS Date normalize invalid calendar fields.
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
        return null;
    if (offsetMin < -840 || offsetMin > 840)
        return null; // valid civil TZ offsets only
    // Whole-second UTC ms (no ms truncation of the fractional field).
    const wholeUtcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60_000;
    if (!Number.isFinite(wholeUtcMs))
        return null;
    // Reject JS calendar normalization (e.g. Feb 30 → Mar 1/2).
    // Reconstruct the wall-clock components we intended in the offset zone:
    const localMs = wholeUtcMs + offsetMin * 60_000;
    const local = new Date(localMs);
    if (local.getUTCFullYear() !== year
        || local.getUTCMonth() + 1 !== month
        || local.getUTCDate() !== day
        || local.getUTCHours() !== hour
        || local.getUTCMinutes() !== minute
        || local.getUTCSeconds() !== second)
        return null;
    // .NET ticks: 100ns since 0001-01-01. 1 us = 10 ticks. Preserve all 6 fractional digits.
    const ticks = BigInt(wholeUtcMs) * 10000n + BigInt(micros) * 10n + 621355968000000000n;
    return `ticks:${ticks.toString()}`;
}
async function getProcessStartIdentityWindows(pid, deadlineAt) {
    for (const command of [
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`,
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if ($p -and $p.CreationDate) { ([DateTime]$p.CreationDate).ToUniversalTime().Ticks }`,
    ]) {
        try {
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
                timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true,
            });
            const ticks = stdout.trim().match(/^\d+$/)?.[0];
            if (ticks)
                return `ticks:${ticks}`;
        }
        catch { /* try the next exact Windows identity source */ }
        if (isDeadlineExceeded(deadlineAt))
            return null;
    }
    try {
        const { stdout } = await execFileAsync('wmic', [
            'process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/format:csv',
        ], { timeout: Math.max(1, Math.min(5000, remainingDeadlineMs(deadlineAt) ?? 5000)), windowsHide: true });
        const match = stdout.match(/(\d{14}\.\d{6}[+-]\d{3})/);
        return match ? dmtfCreationDateToTicks(match[1]) : null;
    }
    catch {
        return null;
    }
}
/** Stable PID-reuse identity suitable for a durable worker manifest. */
export async function getProcessStartIdentity(pid, deadlineAt) {
    if (!Number.isInteger(pid) || pid <= 0 || isDeadlineExceeded(deadlineAt))
        return null;
    if (process.platform === 'win32')
        return getProcessStartIdentityWindows(pid, deadlineAt);
    const startTime = await getProcessStartTime(pid, deadlineAt);
    return startTime === undefined || isDeadlineExceeded(deadlineAt) ? null : String(startTime);
}
export async function isProcessIdentityLive(pid, expectedStartIdentity, deadlineAt) {
    if (!Number.isInteger(pid) || pid <= 0 || !expectedStartIdentity || isDeadlineExceeded(deadlineAt)) {
        return isDeadlineExceeded(deadlineAt) ? 'unknown' : 'dead';
    }
    if (!isProcessAlive(pid))
        return 'dead';
    // Normalize legacy dmtf: identities to ticks: BEFORE comparison so Windows
    // lookup (which returns ticks:) can match persisted pre-normalization records.
    let expected = expectedStartIdentity;
    if (expected.startsWith('dmtf:')) {
        const converted = dmtfCreationDateToTicks(expected.slice('dmtf:'.length));
        if (!converted)
            return 'unknown'; // malformed legacy identity is not authority
        expected = converted;
    }
    const identity = await getProcessStartIdentity(pid, deadlineAt);
    if (identity === null)
        return isProcessAlive(pid) ? 'unknown' : 'dead';
    return identity === expected ? 'live' : 'mismatch';
}
/**
 * Terminate only a process whose durable start identity still matches. Windows
 * binds verification to one exact root process identity and uses handles while
 * enumerating descendants; this remains a generic tree cleanup API, not a
 * creation-bound launch-owned authority. Launch-owned callers must use the
 * exact process-group API on POSIX and refuse unsupported Windows reconnects.
 */
export async function terminateOwnedProcessTree(options) {
    const deadline = parseDeadline(options.deadlineAt);
    if (deadline === undefined || isDeadlineExceeded(deadline))
        return 'deadline-exceeded';
    const liveness = await isProcessIdentityLive(options.pid, options.expectedStartIdentity, deadline);
    if (liveness === 'dead')
        return 'already-dead';
    if (liveness === 'mismatch')
        return 'identity-mismatch';
    if (liveness === 'unknown') {
        return isDeadlineExceeded(deadline) ? 'deadline-exceeded' : 'unknown';
    }
    if (isDeadlineExceeded(deadline))
        return 'deadline-exceeded';
    if (process.platform !== 'win32') {
        return killProcessTreeUnix(options.pid, options.force ? 'SIGKILL' : 'SIGTERM')
            ? 'terminated'
            : (isProcessAlive(options.pid) ? 'unknown' : 'already-dead');
    }
    const timeout = remainingDeadlineMs(deadline);
    if (!timeout)
        return 'deadline-exceeded';
    let expectedTicks = options.expectedStartIdentity.match(/^ticks:(\d+)$/)?.[1];
    if (!expectedTicks) {
        // Legacy manifests may still carry dmtf: identities from pre-normalization builds.
        const dmtf = options.expectedStartIdentity.match(/^dmtf:(.+)$/)?.[1];
        const converted = dmtf ? dmtfCreationDateToTicks(dmtf) : null;
        expectedTicks = converted?.match(/^ticks:(\d+)$/)?.[1];
    }
    if (!expectedTicks)
        return 'unknown';
    const waitMs = Math.max(1, timeout);
    const script = [
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class OmcNative {',
        '  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);',
        '  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);',
        '}',
        '"@',
        `$root = [System.Diagnostics.Process]::GetProcessById(${options.pid})`,
        `if ($root.StartTime.ToUniversalTime().Ticks -ne ${expectedTicks}) { exit 3 }`,
        '$owned = @{}',
        '$owned[$root.Id] = @{ Process = $root; Depth = 0; Suspended = $true }',
        '[void][OmcNative]::NtSuspendProcess($root.Handle)',
        'try {',
        '  for ($pass = 0; $pass -lt 64; $pass++) {',
        '    $added = $false',
        '    foreach ($row in Get-CimInstance Win32_Process) {',
        '      $parent = [int]$row.ParentProcessId; $id = [int]$row.ProcessId',
        '      if (-not $owned.ContainsKey($parent) -or $owned.ContainsKey($id)) { continue }',
        '      try {',
        '        $process = [System.Diagnostics.Process]::GetProcessById($id)',
        '        $created = ([DateTime]$row.CreationDate).ToUniversalTime().Ticks',
        '        if ($process.StartTime.ToUniversalTime().Ticks -ne $created) { continue }',
        '        [void][OmcNative]::NtSuspendProcess($process.Handle)',
        '        $owned[$id] = @{ Process = $process; Depth = ([int]$owned[$parent].Depth + 1); Suspended = $true }',
        '        $added = $true',
        '      } catch {}',
        '    }',
        '    if (-not $added) { break }',
        '  }',
        '  $ordered = $owned.Values | Sort-Object -Property Depth -Descending',
        '  foreach ($entry in $ordered) {',
        '    try {',
        '      if (-not $entry.Process.HasExited) { $entry.Process.Kill() }',
        '      $entry.Suspended = $false',
        '    } catch {',
        '      # Kill failed: resume this process so it is not left frozen.',
        '      try { if ($entry.Suspended -and -not $entry.Process.HasExited) { [void][OmcNative]::NtResumeProcess($entry.Process.Handle) } } catch {}',
        '      exit 4',
        '    }',
        '  }',
        `  if (-not $root.WaitForExit(${waitMs})) {`,
        '    # Deadline exceeded after suspension: resume any still-suspended processes.',
        '    foreach ($entry in $ordered) { try { if ($entry.Suspended -and -not $entry.Process.HasExited) { [void][OmcNative]::NtResumeProcess($entry.Process.Handle) } } catch {} }',
        '    exit 5',
        '  }',
        '} catch {',
        '  # Outer failure (e.g. CIM enumeration error): resume every suspended process.',
        '  foreach ($entry in $owned.Values) { try { if ($entry.Suspended -and -not $entry.Process.HasExited) { [void][OmcNative]::NtResumeProcess($entry.Process.Handle) } } catch {} }',
        '  exit 6',
        '} finally {',
        '  # Final safety net: resume any process still marked suspended.',
        '  foreach ($entry in $owned.Values) { try { if ($entry.Suspended -and -not $entry.Process.HasExited) { [void][OmcNative]::NtResumeProcess($entry.Process.Handle) } } catch {} }',
        '}',
    ].join("\n");
    try {
        await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout });
        return 'terminated';
    }
    catch (error) {
        if (isDeadlineExceeded(deadline))
            return 'deadline-exceeded';
        const status = error.status ?? error.code;
        if (status === 3)
            return 'identity-mismatch';
        if (!isProcessAlive(options.pid))
            return 'already-dead';
        // exit 4 (kill failed), exit 5 (deadline after suspension), exit 6 (outer failure):
        // all suspended processes have been resumed by the finally block, but we cannot
        // prove termination, so return unknown rather than claiming success.
        return 'unknown';
    }
}
//# sourceMappingURL=process-utils.js.map