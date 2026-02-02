import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface BackgroundProcessGuardInput {
  hook_event_name: 'BeforeToolUse' | 'AfterToolUse';
  cwd: string;
}

export interface HookOutput {
  continue: boolean;
  message?: string;
}

const MAX_BG_PROCESSES = 10; // Configurable via omc.json

interface ProcessInfo {
  pid: number;
  startTime: number;
  command: string;
}

/**
 * Get all child processes spawned by Claude Code
 */
function getBackgroundProcesses(): ProcessInfo[] {
  try {
    // Get current process tree
    const result = child_process.execSync(
      `ps -o pid,lstart,command --no-headers --ppid ${process.pid}`,
      { encoding: 'utf-8' }
    );

    const lines = result.trim().split('\n').filter(line => line.length > 0);
    
    return lines.map(line => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s{2,}(.+)$/);
      if (!match) return null;

      const [, pid, lstart, command] = match;
      return {
        pid: parseInt(pid, 10),
        startTime: new Date(lstart).getTime(),
        command: command.trim()
      };
    }).filter((p): p is ProcessInfo => p !== null);
  } catch (error) {
    // If ps fails (e.g., on Windows), return empty
    return [];
  }
}

/**
 * Kill oldest background processes
 */
function killOldestProcesses(count: number, processes: ProcessInfo[]): void {
  // Sort by start time (oldest first)
  const sorted = processes.sort((a, b) => a.startTime - b.startTime);
  
  for (let i = 0; i < count && i < sorted.length; i++) {
    try {
      process.kill(sorted[i].pid, 'SIGTERM');
      console.warn(`[background-process-guard] Killed process ${sorted[i].pid}: ${sorted[i].command}`);
    } catch (error) {
      // Process might already be dead
    }
  }
}

/**
 * Load max process limit from config
 */
function getMaxProcessLimit(cwd: string): number {
  try {
    const configPath = path.join(cwd, 'omc.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.maxBackgroundProcesses || MAX_BG_PROCESSES;
    }
  } catch (error) {
    // Ignore config errors
  }
  return MAX_BG_PROCESSES;
}

/**
 * Check and limit background processes
 */
export default function backgroundProcessGuard(input: BackgroundProcessGuardInput): HookOutput {
  const maxProcesses = getMaxProcessLimit(input.cwd);
  const bgProcesses = getBackgroundProcesses();

  if (bgProcesses.length > maxProcesses) {
    const excessCount = bgProcesses.length - maxProcesses;
    
    console.warn(
      `[background-process-guard] Too many background processes (${bgProcesses.length}/${maxProcesses})`
    );
    console.warn(`[background-process-guard] Killing ${excessCount} oldest processes`);

    killOldestProcesses(excessCount, bgProcesses);

    return {
      continue: true,
      message: `⚠️ Background process limit (${maxProcesses}) exceeded. Killed ${excessCount} oldest processes to prevent system overload.`
    };
  }

  return { continue: true };
}
