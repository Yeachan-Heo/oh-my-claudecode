#!/usr/bin/env node

/**
 * OMC Stale Worker Cleanup
 *
 * Detects and terminates stale OMC tmux/CLI worker processes that still
 * carry team identity after the team cancellation path has completed. This is
 * a post-cancellation cleanup tool; Claude Code 2.1.178+ has no native
 * TeamDelete or per-team config to use as an orphan signal.
 *
 * Usage:
 *   node cleanup-orphans.mjs [--team-name <name>] [--dry-run]
 *
 * When --team-name is provided, only checks stale workers from that team.
 * When omitted, scans for ALL matching OMC worker processes.
 *
 * --dry-run: Report matching workers without killing them.
 *
 * Exit codes:
 *   0 - Success (workers cleaned or none found)
 *   1 - Error during cleanup
 */

import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const teamNameIdx = args.indexOf('--team-name');
const rawTeamName = teamNameIdx !== -1 ? args[teamNameIdx + 1] : null;
const dryRun = args.includes('--dry-run');

// Validate team name to prevent path traversal and injection
const TEAM_NAME_RE = /^[\w][\w-]{0,63}$/;
const teamName = rawTeamName && TEAM_NAME_RE.test(rawTeamName) ? rawTeamName : null;
if (rawTeamName && !teamName) {
  console.error(`[cleanup-orphans] Invalid team name: ${rawTeamName}`);
  process.exit(1);
}

/**
 * Find OMC tmux/CLI worker processes that match team patterns.
 * Cross-platform: uses ps on Unix, tasklist on Windows.
 */
function findOrphanProcesses(filterTeam) {
  const workers = [];

  try {
    if (process.platform === 'win32') {
      const output = getWindowsProcessListOutput();
      if (!output) return workers;

      for (const line of output.split('\n')) {
        if (line.includes('--team-name') || line.includes('team_name')) {
          // Restrict team name match to valid slug characters (alphanumeric + hyphens)
          const match = line.match(/--team-name[=\s]+([\w][\w-]{0,63})/i) || line.match(/team_name[=:]\s*"?([\w][\w-]{0,63})"?/i);
          if (match) {
            const procTeam = match[1];
            if (filterTeam && procTeam !== filterTeam) continue;

            const pidMatch = line.match(/,(\d+)\s*$/);
            if (pidMatch) {
              workers.push({ pid: parseInt(pidMatch[1], 10), team: procTeam, cmd: line.trim() });
            }
          }
        }
      }
    } else {
      // Unix (macOS / Linux): use ps
      const output = execSync('ps aux', { encoding: 'utf-8', timeout: 10000 });

      for (const line of output.split('\n')) {
        // Match OMC worker processes with team context (exclude bare 'node' to avoid over-matching).
        if ((line.includes('claude') || line.includes('codex') || line.includes('gemini') || line.includes('omc') || line.includes('oh-my-claude'))) {
          // Restrict team name match to valid slug characters.
          // Support both legacy args and tmux worker env assignments.
          const match =
            line.match(/--team-name[=\s]+([\w][\w-]{0,63})/i)
            || line.match(/team_name[=:]\s*"?([\w][\w-]{0,63})"?/i)
            || line.match(/OM[CX]_TEAM_NAME=(['"]?)([\w][\w-]{0,63})\1/i)
            || line.match(/OM[CX]_TEAM_WORKER=(['"]?)([\w][\w-]{0,63})\/worker-\d+\1/i);
          const procTeam = match?.[2] || match?.[1];
          if (procTeam) {
            if (filterTeam && procTeam !== filterTeam) continue;

            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[1], 10);
            if (pid && pid !== process.pid && pid !== process.ppid) {
              workers.push({ pid, team: procTeam, cmd: '(redacted)' });
            }
          }
        }
      }
    }
  } catch {
    // ps/wmic failed — can't detect stale workers
  }

  return workers;
}

function getWindowsProcessListOutput() {
  try {
    // Primary path: WMIC (legacy but still available on some systems).
    return execSync(
      'wmic process where "name like \'%node%\' or name like \'%claude%\'" get processid,commandline /format:csv',
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
  } catch {
    // Fallback: PowerShell CIM query for command line + PID.
    try {
      return execSync(
        'powershell -NoProfile -NonInteractive -Command "$procs = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -like \'*node*\' -or $_.Name -like \'*claude*\' }; $procs | ForEach-Object { [string]$_.CommandLine + \',\' + [string]$_.ProcessId }"',
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
    } catch {
      return '';
    }
  }
}


/**
 * Kill a process.
 *
 * On Windows: `taskkill /F` terminates synchronously.
 *
 * On Unix: issue SIGTERM for graceful exit. A best-effort SIGKILL escalation
 * is scheduled 5s later, but the timer is `.unref()`ed so it does not block
 * the Node event loop — main() exits promptly after SIGTERM and does not
 * hang waiting for the escalation window to elapse. In practice, OMC agent
 * processes (claude/codex/gemini/omc) respect SIGTERM and exit within
 * milliseconds; the SIGKILL path is a safety net that only fires if the
 * caller's event loop stays alive long enough (e.g., another timer or I/O
 * keeps the process running past 5s). Callers that need guaranteed
 * escalation should poll `process.kill(pid, 0)` themselves or re-run this
 * script. See commit message for the rationale behind removing the implicit
 * 5s hang this function previously caused.
 */
function killProcess(pid) {
  // Validate PID is a positive integer (prevent command injection)
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { timeout: 10000 });
    } else {
      // Send SIGTERM
      process.kill(pid, 'SIGTERM');

      // Schedule a best-effort SIGKILL escalation after 5s.
      // .unref() ensures this pending timer does not keep the Node event
      // loop alive — without it, main() would appear to "hang" for 5s per
      // stale worker after printing the JSON result.
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Check if still running
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already exited
        }
      }, 5000).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function main() {
  const processes = findOrphanProcesses(teamName);

  if (processes.length === 0) {
    console.log(JSON.stringify({
      cleaned: 0,
      message: teamName
        ? `No stale OMC worker processes found for team "${teamName}".`
        : 'No stale OMC worker processes found.',
    }));
    process.exit(0);
  }


  const results = [];

  for (const worker of processes) {
    if (dryRun) {
      results.push({ pid: worker.pid, team: worker.team, action: 'would_kill' });
      console.error(`[dry-run] Would kill PID ${worker.pid} (team: ${worker.team})`);
    } else {
      const killed = killProcess(worker.pid);
      results.push({ pid: worker.pid, team: worker.team, action: killed ? 'killed' : 'failed' });
      console.error(`[cleanup] ${killed ? 'Killed' : 'Failed to kill'} PID ${worker.pid} (team: ${worker.team})`);
    }
  }

  console.log(JSON.stringify({
    cleaned: processes.length,
    dryRun,
    results,
    message: dryRun
      ? `Found ${processes.length} stale worker(s). Re-run without --dry-run to clean up.`
      : `Cleaned up ${results.filter(r => r.action === 'killed').length}/${processes.length} stale worker(s).`,
  }));

  // Exit explicitly so we don't depend on timer/handle lifetime to end the
  // process. The SIGKILL escalation timers scheduled in killProcess() are
  // .unref()ed and therefore do not block exit; this line makes the intent
  // symmetric with the earlier no-worker return paths (which already call
  // process.exit(0)).
  process.exit(0);
}

main();
