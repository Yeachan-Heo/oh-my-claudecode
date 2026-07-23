import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import type { GraphProcessIdentity } from './runtime-types.js';

export class GraphPlatformError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GraphPlatformError';
    this.code = code;
  }
}

export type GraphProcessLiveness = boolean | 'unknown';

export interface GraphPlatformAdapter {
  preflight(): GraphProcessIdentity;
  isProcessIdentityLive(identity: GraphProcessIdentity): GraphProcessLiveness;
}

export interface GraphPlatformDependencies {
  platform: NodeJS.Platform;
  pid: number;
  fileExists(path: string): boolean;
  readText(path: string): string;
  execCommand(command: string): string;
}

function parseLinuxProcessStart(stat: string): string | null {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const processStart = fields[19];
  return processStart && /^\d+$/.test(processStart) ? processStart : null;
}

function readProcessStartLinux(pid: number, deps: GraphPlatformDependencies): string | null {
  try {
    return parseLinuxProcessStart(deps.readText(`/proc/${pid}/stat`));
  } catch {
    return null;
  }
}

function readProcessStartDarwin(pid: number, deps: GraphPlatformDependencies): string | null {
  try {
    const output = deps.execCommand(`LC_ALL=C ps -p ${pid} -o lstart=`);
    const trimmed = output.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return String(Math.floor(ms / 1000));
  } catch {
    return null;
  }
}

function readProcessStartWindows(pid: number, deps: GraphPlatformDependencies): string | null {
  try {
    const output = deps.execCommand(
      `powershell -NoProfile -Command "[math]::Floor(((Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime - (Get-Date '1970-01-01')).TotalSeconds)"`,
    );
    const trimmed = output.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

function readProcessStart(pid: number, platform: NodeJS.Platform, deps: GraphPlatformDependencies): string | null {
  if (platform === 'linux') return readProcessStartLinux(pid, deps);
  if (platform === 'darwin') return readProcessStartDarwin(pid, deps);
  if (platform === 'win32') return readProcessStartWindows(pid, deps);
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Tracks pids that have already emitted the pid-only fallback warning so we
// warn once per pid instead of on every liveness poll. The fallback loses
// PID-reuse protection; the warning is observability only and does not change
// liveness semantics.
const warnedPidOnlyFallback = new Set<number>();

export function createGraphPlatformAdapter(
  overrides: Partial<GraphPlatformDependencies> = {},
): GraphPlatformAdapter {
  const dependencies: GraphPlatformDependencies = {
    platform: process.platform,
    pid: process.pid,
    fileExists: existsSync,
    readText: (path) => readFileSync(path, 'utf8'),
    execCommand: (command) =>
      execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }),
    ...overrides,
  };
  return {
    preflight(): GraphProcessIdentity {
      const processStart = readProcessStart(dependencies.pid, dependencies.platform, dependencies);
      if (!processStart) {
        return { pid: dependencies.pid, process_start: '' };
      }
      return { pid: dependencies.pid, process_start: processStart };
    },

    isProcessIdentityLive(identity: GraphProcessIdentity): GraphProcessLiveness {
      if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'unknown';
      // pid-only liveness is always available as a fallback (e.g. when the host
      // could not capture process_start at reservation time). A dead pid is
      // definitively not live; only return 'unknown' if even this check throws.
      let alive: boolean;
      try {
        alive = isProcessAlive(identity.pid);
      } catch {
        return 'unknown';
      }
      if (!alive) return false;
      if (!identity.process_start) {
        if (!warnedPidOnlyFallback.has(identity.pid)) {
          warnedPidOnlyFallback.add(identity.pid);
          console.warn(
            `graph: pid-only liveness fallback used for pid ${identity.pid} (process_start unavailable); PID-reuse protection is degraded`,
          );
        }
        return true;
      }
      const current = readProcessStart(identity.pid, dependencies.platform, dependencies);
      if (!current) return 'unknown';
      return current === identity.process_start;
    },
  };
}

export const graphPlatform = createGraphPlatformAdapter();
