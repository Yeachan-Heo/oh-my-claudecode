/**
 * Bridge Manager - Python process lifecycle management
 *
 * Manages the gyoshu_bridge.py process:
 * - Spawning with proper environment detection
 * - Ensuring single bridge per session with security validations
 * - Graceful shutdown with signal escalation
 * - PID reuse detection via process identity verification
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { BridgeMeta, PythonEnvInfo } from './types.js';
import { getSessionDir, getBridgeSocketPath, getBridgeMetaPath } from './paths.js';
import { atomicWriteJson, safeReadJson, ensureDirSync } from '../../lib/atomic-write.js';

const execFileAsync = promisify(execFile);

// =============================================================================
// CONSTANTS
// =============================================================================

const BRIDGE_SPAWN_TIMEOUT_MS = 30000; // 30 seconds to wait for socket
const DEFAULT_GRACE_PERIOD_MS = 5000; // 5 seconds for SIGINT
const SIGTERM_GRACE_MS = 2500; // 2.5 seconds for SIGTERM

// =============================================================================
// TYPES
// =============================================================================

export interface EscalationResult {
  terminated: boolean;
  terminatedBy?: 'SIGINT' | 'SIGTERM' | 'SIGKILL';
  terminationTimeMs?: number;
}

// =============================================================================
// BRIDGE PATH RESOLUTION
// =============================================================================

/**
 * Resolve the path to gyoshu_bridge.py relative to this module.
 * The bridge script is at: <package-root>/bridge/gyoshu_bridge.py
 */
function getBridgeScriptPath(): string {
  // In ESM, __dirname equivalent is:
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // From src/tools/python-repl/ -> ../../.. -> package root -> bridge/
  const packageRoot = path.resolve(__dirname, '..', '..', '..');
  return path.join(packageRoot, 'bridge', 'gyoshu_bridge.py');
}

// =============================================================================
// PYTHON ENVIRONMENT DETECTION
// =============================================================================

/**
 * Detect an existing Python virtual environment in the project directory.
 * Returns null if no .venv is found.
 */
function detectExistingPythonEnv(projectRoot: string): PythonEnvInfo | null {
  const isWindows = process.platform === 'win32';
  const binDir = isWindows ? 'Scripts' : 'bin';
  const pythonExe = isWindows ? 'python.exe' : 'python';
  const venvPython = path.join(projectRoot, '.venv', binDir, pythonExe);

  if (fs.existsSync(venvPython)) {
    return { pythonPath: venvPython, type: 'venv' };
  }
  return null;
}

/**
 * Ensure a Python environment is available for the project.
 * Currently requires an existing .venv - does not auto-create.
 */
async function ensurePythonEnvironment(projectRoot: string): Promise<PythonEnvInfo> {
  const existing = detectExistingPythonEnv(projectRoot);
  if (existing) {
    return existing;
  }

  // Fallback: try system python3
  try {
    await execFileAsync('python3', ['--version']);
    return { pythonPath: 'python3', type: 'venv' };
  } catch {
    // python3 not available
  }

  throw new Error(
    'No Python environment found. Create a virtual environment first:\n' +
      '  python -m venv .venv\n' +
      '  .venv/bin/pip install pandas numpy matplotlib'
  );
}

// =============================================================================
// PROCESS IDENTITY VERIFICATION
// =============================================================================

/**
 * Get process start time on Linux via /proc/{pid}/stat field 22.
 */
async function getProcessStartTimeLinux(pid: number): Promise<number | undefined> {
  try {
    const stat = await fsPromises.readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return undefined;

    const fieldsAfterComm = stat.substring(closeParen + 2).split(' ');
    // starttime is field 22 in /proc/pid/stat, index 19 after removing pid and comm
    const startTimeField = fieldsAfterComm[19];
    if (!startTimeField) return undefined;

    const startTime = parseInt(startTimeField, 10);
    return isNaN(startTime) ? undefined : startTime;
  } catch {
    return undefined;
  }
}

/**
 * Get process start time on macOS via `ps -p {pid} -o lstart=`.
 */
async function getProcessStartTimeMacOS(pid: number): Promise<number | undefined> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    const lstart = stdout.trim();
    if (!lstart) return undefined;

    const date = new Date(lstart);
    if (isNaN(date.getTime())) return undefined;

    return date.getTime();
  } catch {
    return undefined;
  }
}

/**
 * Get process start time for a given PID (cross-platform).
 */
async function getProcessStartTime(pid: number): Promise<number | undefined> {
  if (process.platform === 'linux') {
    return getProcessStartTimeLinux(pid);
  } else if (process.platform === 'darwin') {
    return getProcessStartTimeMacOS(pid);
  }
  return undefined;
}

/**
 * Check if a process is alive (basic check, no start time verification).
 */
function isProcessAliveBasic(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that a bridge process is still running and is the same process
 * that was originally spawned (guards against PID reuse).
 *
 * Returns false if:
 * - Process is not alive
 * - Start time was recorded but doesn't match (PID reused)
 * - Start time was recorded but cannot be retrieved (fail-closed)
 */
export async function verifyProcessIdentity(meta: BridgeMeta): Promise<boolean> {
  // Basic alive check first
  if (!isProcessAliveBasic(meta.pid)) {
    return false;
  }

  // If we have a recorded start time, verify it matches
  if (meta.processStartTime !== undefined) {
    const currentStartTime = await getProcessStartTime(meta.pid);

    // Fail-closed: if we can't get current start time but we have a recorded one,
    // assume PID reuse has occurred (safer than assuming same process)
    if (currentStartTime === undefined) {
      return false;
    }

    if (currentStartTime !== meta.processStartTime) {
      return false; // PID reuse detected
    }
  }

  return true;
}

// =============================================================================
// SOCKET UTILITIES
// =============================================================================

/**
 * Check if a path points to a Unix socket.
 */
function isSocket(socketPath: string): boolean {
  try {
    const stat = fs.lstatSync(socketPath);
    return stat.isSocket();
  } catch {
    return false;
  }
}

/**
 * Safely unlink a socket file if it exists within the expected directory.
 */
function safeUnlinkSocket(socketPath: string): void {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // Ignore errors
  }
}

// =============================================================================
// BRIDGE METADATA VALIDATION
// =============================================================================

/**
 * Validate that parsed JSON matches BridgeMeta schema.
 */
function isValidBridgeMeta(data: unknown): data is BridgeMeta {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  return (
    typeof obj.pid === 'number' &&
    Number.isInteger(obj.pid) &&
    obj.pid > 0 &&
    typeof obj.socketPath === 'string' &&
    typeof obj.startedAt === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.pythonEnv === 'object' &&
    obj.pythonEnv !== null &&
    typeof (obj.pythonEnv as Record<string, unknown>).pythonPath === 'string' &&
    (obj.processStartTime === undefined || typeof obj.processStartTime === 'number')
  );
}

// =============================================================================
// PROCESS GROUP MANAGEMENT
// =============================================================================

/**
 * Kill a process group (process + children).
 * Uses negative PID to target the process group.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    // Negative PID sends signal to process group
    process.kill(-pid, signal);
    return true;
  } catch {
    // Process might already be dead
    try {
      // Fallback: kill just the process
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// SPAWN BRIDGE SERVER
// =============================================================================

/**
 * Spawn a new bridge server process for the given session.
 *
 * @param sessionId - Unique session identifier
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns BridgeMeta containing process information
 */
export async function spawnBridgeServer(
  sessionId: string,
  projectDir?: string
): Promise<BridgeMeta> {
  const sessionDir = getSessionDir(sessionId);
  ensureDirSync(sessionDir);

  const socketPath = getBridgeSocketPath(sessionId);
  const bridgePath = getBridgeScriptPath();

  // Verify bridge script exists
  if (!fs.existsSync(bridgePath)) {
    throw new Error(`Bridge script not found: ${bridgePath}`);
  }

  // Clean up any stale socket
  safeUnlinkSocket(socketPath);

  const effectiveProjectDir = projectDir || process.cwd();
  const pythonEnv = await ensurePythonEnvironment(effectiveProjectDir);

  // Pass socket path as positional argument (matches gyoshu_bridge.py argparse)
  const bridgeArgs = [bridgePath, socketPath];

  const proc: ChildProcess = spawn(pythonEnv.pythonPath, bridgeArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: effectiveProjectDir,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    detached: true,
  });

  proc.unref();

  // Capture stderr for error reporting (capped at 64KB)
  const MAX_STDERR_CHARS = 64 * 1024;
  let stderrBuffer = '';
  let stderrTruncated = false;

  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderrTruncated) return;
    const text = chunk.toString();
    if (stderrBuffer.length + text.length > MAX_STDERR_CHARS) {
      stderrBuffer = stderrBuffer.slice(0, MAX_STDERR_CHARS - 20) + '\n...[truncated]';
      stderrTruncated = true;
    } else {
      stderrBuffer += text;
    }
  });

  // Wait for socket to appear
  const startTime = Date.now();
  while (!isSocket(socketPath)) {
    if (Date.now() - startTime > BRIDGE_SPAWN_TIMEOUT_MS) {
      // Kill the process on timeout
      if (proc.pid) {
        killProcessGroup(proc.pid, 'SIGKILL');
      }

      // Clean up any non-socket file that might exist (poisoning attempt)
      if (fs.existsSync(socketPath) && !isSocket(socketPath)) {
        safeUnlinkSocket(socketPath);
      }

      throw new Error(
        `Bridge failed to create socket in ${BRIDGE_SPAWN_TIMEOUT_MS}ms. ` +
          `Stderr: ${stderrBuffer || '(empty)'}`
      );
    }
    await sleep(100);
  }

  // Get process start time for PID reuse detection
  const processStartTime = proc.pid ? await getProcessStartTime(proc.pid) : undefined;

  const meta: BridgeMeta = {
    pid: proc.pid!,
    socketPath,
    startedAt: new Date().toISOString(),
    sessionId,
    pythonEnv,
    processStartTime,
  };

  // Persist metadata
  const metaPath = getBridgeMetaPath(sessionId);
  await atomicWriteJson(metaPath, meta);

  return meta;
}

// =============================================================================
// ENSURE BRIDGE
// =============================================================================

/**
 * Get or spawn a bridge server for the session.
 *
 * Implements security validations:
 * - Anti-poisoning: Verifies sessionId in metadata matches expected
 * - Anti-hijack: Verifies socketPath is the expected canonical path
 * - Socket type: Verifies the socket path is actually a socket
 * - Process identity: Verifies PID + start time match
 *
 * @param sessionId - Unique session identifier
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns BridgeMeta for the active bridge
 */
export async function ensureBridge(sessionId: string, projectDir?: string): Promise<BridgeMeta> {
  const metaPath = getBridgeMetaPath(sessionId);
  const expectedSocketPath = getBridgeSocketPath(sessionId);

  const meta = await safeReadJson<BridgeMeta>(metaPath);

  if (meta && isValidBridgeMeta(meta)) {
    // Security validation 1: Anti-poisoning - verify sessionId matches
    if (meta.sessionId !== sessionId) {
      await deleteBridgeMeta(sessionId);
      return spawnBridgeServer(sessionId, projectDir);
    }

    // Security validation 2: Anti-hijack - verify socket path is expected
    if (meta.socketPath !== expectedSocketPath) {
      await deleteBridgeMeta(sessionId);
      return spawnBridgeServer(sessionId, projectDir);
    }

    // Security validation 3: Process identity - verify PID is still our process
    const stillOurs = await verifyProcessIdentity(meta);
    if (stillOurs) {
      // Security validation 4: Socket type - verify it's actually a socket
      if (isSocket(meta.socketPath)) {
        return meta;
      } else {
        // Socket missing or wrong type - kill the orphan process
        try {
          process.kill(meta.pid, 'SIGKILL');
        } catch {
          // Process might already be dead
        }
      }
    }

    await deleteBridgeMeta(sessionId);
  }

  return spawnBridgeServer(sessionId, projectDir);
}

// =============================================================================
// KILL BRIDGE WITH ESCALATION
// =============================================================================

/**
 * Terminate a bridge process with signal escalation.
 *
 * Escalation order:
 * 1. SIGINT - wait gracePeriodMs (default 5000ms)
 * 2. SIGTERM - wait 2500ms
 * 3. SIGKILL - immediate termination
 *
 * Uses process group kill (-pid) to also terminate child processes.
 *
 * @param sessionId - Session whose bridge to kill
 * @param options - Optional configuration
 * @returns EscalationResult with termination details
 */
export async function killBridgeWithEscalation(
  sessionId: string,
  options?: { gracePeriodMs?: number }
): Promise<EscalationResult> {
  const gracePeriod = options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const startTime = Date.now();

  const metaPath = getBridgeMetaPath(sessionId);
  const meta = await safeReadJson<BridgeMeta>(metaPath);

  if (!meta || !isValidBridgeMeta(meta)) {
    return { terminated: true }; // Already dead or no metadata
  }

  // Anti-poisoning check
  if (meta.sessionId !== sessionId) {
    await deleteBridgeMeta(sessionId);
    return { terminated: true };
  }

  // Verify we're killing the right process
  if (!(await verifyProcessIdentity(meta))) {
    await deleteBridgeMeta(sessionId);
    return { terminated: true }; // Process already dead or PID reused
  }

  // Helper to wait for process exit with identity verification
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const checkStart = Date.now();
    while (Date.now() - checkStart < timeoutMs) {
      const stillOurs = await verifyProcessIdentity(meta);
      if (!stillOurs) {
        return true; // Process is gone or PID reused
      }
      await sleep(100);
    }
    return false;
  };

  let terminatedBy: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGINT';

  // Stage 1: SIGINT
  killProcessGroup(meta.pid, 'SIGINT');

  if (!(await waitForExit(gracePeriod))) {
    // Stage 2: SIGTERM
    terminatedBy = 'SIGTERM';
    killProcessGroup(meta.pid, 'SIGTERM');

    if (!(await waitForExit(SIGTERM_GRACE_MS))) {
      // Stage 3: SIGKILL
      terminatedBy = 'SIGKILL';
      killProcessGroup(meta.pid, 'SIGKILL');
      await waitForExit(1000); // Brief wait for SIGKILL
    }
  }

  // Cleanup
  await deleteBridgeMeta(sessionId);

  const sessionDir = getSessionDir(sessionId);
  const socketPath = meta.socketPath;
  if (socketPath.startsWith(sessionDir)) {
    safeUnlinkSocket(socketPath);
  }

  return {
    terminated: true,
    terminatedBy,
    terminationTimeMs: Date.now() - startTime,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Delete bridge metadata file.
 */
async function deleteBridgeMeta(sessionId: string): Promise<void> {
  const metaPath = getBridgeMetaPath(sessionId);
  try {
    await fsPromises.unlink(metaPath);
  } catch {
    // Ignore errors (file might not exist)
  }
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
