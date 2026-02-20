#!/usr/bin/env node

/**
 * OMC Orphan Agent Cleanup
 *
 * Detects and terminates orphan agent processes — agents whose team
 * config has been deleted (via TeamDelete) but whose OS processes
 * are still running. This happens when TeamDelete fires before all
 * teammates confirm shutdown.
 *
 * Usage:
 *   node cleanup-orphans.mjs [--team-name <name>] [--dry-run]
 *
 * When --team-name is provided, only checks for orphans from that team.
 * When omitted, scans for ALL orphan claude agent processes.
 *
 * --dry-run: Report orphans without killing them.
 *
 * Exit codes:
 *   0 - Success (orphans cleaned or none found)
 *   1 - Error during cleanup
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
 * Find claude agent processes that match team patterns.
 * Cross-platform: uses ps on Unix, tasklist on Windows.
 */
function findOrphanProcesses(filterTeam) {
  const orphans = [];

  try {
    if (process.platform === 'win32') {
      // Windows: use WMIC to find node/claude processes
      const output = execSync(
        'wmic process where "name like \'%node%\' or name like \'%claude%\'" get processid,commandline /format:csv',
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      for (const line of output.split('\n')) {
        if (line.includes('--team-name') || line.includes('team_name')) {
          // Restrict team name match to valid slug characters (alphanumeric + hyphens)
          const match = line.match(/--team-name[=\s]+([\w][\w-]{0,63})/i) || line.match(/team_name[=:]\s*"?([\w][\w-]{0,63})"?/i);
          if (match) {
            const procTeam = match[1];
            if (filterTeam && procTeam !== filterTeam) continue;

            const pidMatch = line.match(/,(\d+)\s*$/);
            if (pidMatch) {
              orphans.push({ pid: parseInt(pidMatch[1], 10), team: procTeam, cmd: line.trim() });
            }
          }
        }
      }
    } else {
      // Unix (macOS / Linux): use ps
      const output = execSync('ps aux', { encoding: 'utf-8', timeout: 10000 });

      for (const line of output.split('\n')) {
        // Match claude agent processes with team context
        if ((line.includes('claude') || line.includes('node')) &&
            (line.includes('--team-name') || line.includes('team_name'))) {

          // Restrict team name match to valid slug characters
          const match = line.match(/--team-name[=\s]+([\w][\w-]{0,63})/i) || line.match(/team_name[=:]\s*"?([\w][\w-]{0,63})"?/i);
          if (match) {
            const procTeam = match[1];
            if (filterTeam && procTeam !== filterTeam) continue;

            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[1], 10);
            if (pid && pid !== process.pid && pid !== process.ppid) {
              orphans.push({ pid, team: procTeam, cmd: line.trim().substring(0, 200) });
            }
          }
        }
      }
    }
  } catch {
    // ps/wmic failed — can't detect orphans
  }

  return orphans;
}

/**
 * Check if a team's config still exists (i.e., team is still active).
 */
function teamConfigExists(name) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const configPath = join(configDir, 'teams', name, 'config.json');
  return existsSync(configPath);
}

/**
 * Kill a process: SIGTERM first, SIGKILL after 5s if still alive.
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

      // Wait 5s, then SIGKILL if still alive
      setTimeout(() => {
        try {
          process.kill(pid, 0); // Check if still running
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already exited
        }
      }, 5000);
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
      orphans: 0,
      message: teamName
        ? `No orphan processes found for team "${teamName}".`
        : 'No orphan agent processes found.',
    }));
    process.exit(0);
  }

  // Filter to actual orphans: processes whose team config no longer exists
  const orphans = processes.filter(p => !teamConfigExists(p.team));

  if (orphans.length === 0) {
    console.log(JSON.stringify({
      orphans: 0,
      message: `Found ${processes.length} team process(es) but all have active team configs.`,
    }));
    process.exit(0);
  }

  const results = [];

  for (const orphan of orphans) {
    if (dryRun) {
      results.push({ pid: orphan.pid, team: orphan.team, action: 'would_kill' });
      console.error(`[dry-run] Would kill PID ${orphan.pid} (team: ${orphan.team})`);
    } else {
      const killed = killProcess(orphan.pid);
      results.push({ pid: orphan.pid, team: orphan.team, action: killed ? 'killed' : 'failed' });
      console.error(`[cleanup] ${killed ? 'Killed' : 'Failed to kill'} PID ${orphan.pid} (team: ${orphan.team})`);
    }
  }

  console.log(JSON.stringify({
    orphans: orphans.length,
    dryRun,
    results,
    message: dryRun
      ? `Found ${orphans.length} orphan(s). Re-run without --dry-run to clean up.`
      : `Cleaned up ${results.filter(r => r.action === 'killed').length}/${orphans.length} orphan(s).`,
  }));
}

main();
