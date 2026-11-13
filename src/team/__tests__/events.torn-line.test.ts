import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTeamEvents } from '../events.js';
import { TeamPaths, absPath } from '../state-paths.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function writeEventsLog(teamName: string, contents: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omc-events-torn-'));
  tempDirs.push(cwd);
  const p = absPath(cwd, TeamPaths.events(teamName));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents, 'utf8');
  return cwd;
}

describe('readTeamEvents with a damaged log', () => {
  it('keeps valid events around a torn line and a trailing partial line', async () => {
    const first = { event_id: 'e1', team: 't', created_at: '2026-01-01T00:00:00.000Z', type: 'task_completed', worker: 'worker-1', task_id: '1' };
    const second = { event_id: 'e2', team: 't', created_at: '2026-01-01T00:01:00.000Z', type: 'team_leader_nudge', worker: 'leader-fixed', reason: 'nudge' };
    const cwd = writeEventsLog('t', [
      JSON.stringify(first),
      '{"event_id":"torn","team":"t","crea',
      JSON.stringify(second),
      '{"event_id":"partial","ty',
    ].join('\n'));

    const events = await readTeamEvents('t', cwd);

    expect(events.map((e) => e.event_id)).toEqual(['e1', 'e2']);
  });
});
