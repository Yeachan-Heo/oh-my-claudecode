/**
 * Cross-Platform Process Utilities
 * Provides unified process management across Windows, macOS, and Linux.
 */
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import * as fsPromises from 'fs/promises';
const execFileAsync = promisify(execFile);
/**
 * Kill a process and optionally its entire process tree.
 *
 * On Windows: Uses taskkill /T for tree kill, /F for force
 * On Unix: Uses negative PID for process group, falls back to direct kill
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
        execSync(`taskkill ${args.join(' ')}`, {
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
            return false;
        }
    }
}
/**
 * Check if a process is alive.
 * Works cross-platform by attempting signal 0.
 */
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Get process start time for PID reuse detection.
 * Returns milliseconds timestamp on macOS/Windows, jiffies on Linux.
 */
export async function getProcessStartTime(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return undefined;
    if (process.platform === 'win32') {
        return getProcessStartTimeWindows(pid);
    }
    else if (process.platform === 'darwin') {
        return getProcessStartTimeMacOS(pid);
    }
    else if (process.platform === 'linux') {
        return getProcessStartTimeLinux(pid);
    }
    return undefined;
}
async function getProcessStartTimeWindows(pid) {
    try {
        const { stdout } = await execFileAsync('wmic', [
            'process', 'where', `ProcessId=${pid}`,
            'get', 'CreationDate', '/format:csv'
        ], { timeout: 5000, windowsHide: true });
        const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2)
            return undefined;
        const match = lines[1].match(/,(\d{14})/);
        if (!match)
            return undefined;
        const d = match[1];
        const date = new Date(parseInt(d.slice(0, 4)), parseInt(d.slice(4, 6)) - 1, parseInt(d.slice(6, 8)), parseInt(d.slice(8, 10)), parseInt(d.slice(10, 12)), parseInt(d.slice(12, 14)));
        return date.getTime();
    }
    catch {
        return undefined;
    }
}
async function getProcessStartTimeMacOS(pid) {
    try {
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
            env: { ...process.env, LC_ALL: 'C' },
            windowsHide: true
        });
        const date = new Date(stdout.trim());
        return isNaN(date.getTime()) ? undefined : date.getTime();
    }
    catch {
        return undefined;
    }
}
async function getProcessStartTimeLinux(pid) {
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
//# sourceMappingURL=process-utils.js.map