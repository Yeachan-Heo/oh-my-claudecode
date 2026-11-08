#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const SESSION_PREFIX = 'omc-team-';

function runTmux(args) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return {
      ok: false,
      code: 1,
      stderr: result.error.message,
      stdout: '',
    };
  }

  return {
    ok: result.status === 0,
    code: result.status ?? 1,
    stderr: (result.stderr || '').trim(),
    stdout: (result.stdout || '').trimEnd(),
  };
}

function printTable(rows) {
  const headers = ['session', 'pane ID', 'command', 'status'];
  const widths = [
    headers[0].length,
    headers[1].length,
    headers[2].length,
    headers[3].length,
  ];

  for (const row of rows) {
    widths[0] = Math.max(widths[0], row.session.length);
    widths[1] = Math.max(widths[1], row.paneId.length);
    widths[2] = Math.max(widths[2], row.command.length);
    widths[3] = Math.max(widths[3], row.status.length);
  }

  const format = (cols) =>
    cols
      .map((col, idx) => col.padEnd(widths[idx]))
      .join('  ')
      .trimEnd();

  const separator = widths
    .map((w) => '-'.repeat(w))
    .join('  ')
    .trimEnd();

  console.log(format(headers));
  console.log(separator);

  for (const row of rows) {
    console.log(format([row.session, row.paneId, row.command, row.status]));
  }
}

function parsePaneLine(line, session) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;

  const paneId = parts[0];
  const paneDead = parts[parts.length - 1];
  const command = parts.slice(1, -1).join(' ');

  return {
    session,
    paneId,
    command,
    status: paneDead === '1' ? 'dead' : 'alive',
  };
}

function main() {
  const sessionsResult = runTmux(['list-sessions', '-F', '#{session_name}']);

  if (!sessionsResult.ok) {
    const err = sessionsResult.stderr || 'tmux is unavailable or no server is running.';
    console.error(`Failed to list tmux sessions: ${err}`);
    process.exit(1);
  }

  const sessions = sessionsResult.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(SESSION_PREFIX));

  if (sessions.length === 0) {
    console.error(`No tmux sessions found with prefix '${SESSION_PREFIX}'.`);
    process.exit(0);
  }

  const rows = [];
  let sawDeadPane = false;

  for (const session of sessions) {
    const panesResult = runTmux([
      'list-panes',
      '-t',
      session,
      '-F',
      '#{pane_id} #{pane_current_command} #{pane_dead}',
    ]);

    if (!panesResult.ok) {
      const err = panesResult.stderr || `failed to list panes for session ${session}`;
      console.error(`Failed to inspect panes for '${session}': ${err}`);
      sawDeadPane = true;
      continue;
    }

    const paneLines = panesResult.stdout
      .split('\n')
      .map((line) => parsePaneLine(line, session))
      .filter(Boolean);

    for (const pane of paneLines) {
      if (pane.status === 'dead') {
        sawDeadPane = true;
      }
      rows.push(pane);
    }
  }

  if (rows.length === 0) {
    console.error('No panes found for matching sessions.');
    process.exit(sawDeadPane ? 1 : 0);
  }

  printTable(rows);
  process.exit(sawDeadPane ? 1 : 0);
}

main();
