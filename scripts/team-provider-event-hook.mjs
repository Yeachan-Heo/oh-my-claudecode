// Claude Code hook for team workers: `node team-provider-event-hook.mjs <Event>`.
// Appends {"v":1,"event":...,"at":<ms>,"attempt":...} to
// $OMC_TEAM_STATE_ROOT/workers/<worker>/provider-events.jsonl with one write.
// It writes only to a regular file: never through a symlinked workers/ or
// worker directory, a symlinked file, or a FIFO (which could block forever).
// Directories are checked again after the open, so one swapped for a symlink
// in between makes the hook skip the write. A no-op on Windows, which ignores
// O_NOFOLLOW.
// Always exits 0 and never prints: hook output or a nonzero exit would show as
// `hook error` in the worker pane and change what the pane reads as.
// The event name comes from argv (src/team/provider-events.ts PROVIDER_EVENT_NAMES
// builds the settings), so a new event needs no change here.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

try {
  const at = Date.now();
  const event = process.argv[2] ?? '';
  const attempt = process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID ?? '';
  const stateRoot = process.env.OMC_TEAM_STATE_ROOT ?? '';
  // OMC_TEAM_WORKER is `<team>/<worker>`.
  const worker = (process.env.OMC_TEAM_WORKER ?? '').split('/').pop() ?? '';
  if (process.platform !== 'win32' && /^[A-Za-z]+$/.test(event) && attempt && stateRoot && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(worker) && !worker.includes('..')) {
    // No mkdir: a missing worker directory means the team is gone, and the hook
    // must not recreate cleaned-up state.
    const dirs = [join(stateRoot, 'workers'), join(stateRoot, 'workers', worker)];
    const path = join(dirs[1], 'provider-events.jsonl');
    const before = await Promise.all(dirs.map(dir => lstat(dir)));
    const handle = before.every(stats => stats.isDirectory())
      ? await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      : undefined;
    try {
      const opened = await handle?.stat();
      const [leaf, ...after] = handle ? await Promise.all([lstat(path), ...dirs.map(dir => lstat(dir))]) : [];
      const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
      if (opened?.isFile() && sameNode(opened, leaf)
        && after.every((stats, index) => stats.isDirectory() && sameNode(stats, before[index]))) {
        await handle.write(`${JSON.stringify({ v: 1, event, at, attempt })}\n`);
      }
    } finally {
      await handle?.close();
    }
  }
} catch {
  // Recording is best-effort; see the header.
}
process.exitCode = 0;
