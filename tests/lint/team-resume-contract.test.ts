/**
 * Static contract for Team resume and cancellation guidance.
 * Runtime state boundaries are covered by state-tools tests.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../../skills/team/SKILL.md', import.meta.url), 'utf8');
const cancel = readFileSync(new URL('../../skills/cancel/SKILL.md', import.meta.url), 'utf8');

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing section: ${start}`);
  return source.slice(from, to);
}

const resume = section(
  skill,
  '### Resume Check (Before Initialization)',
  '### Phase 1: Parse Input',
);
const contract = section(cancel, '## Cancellation Contract', '## What It Does');
const flow = section(cancel, '## Cancellation Flow', '## Preserved State').replace(/\s+/g, ' ');

/** Execute only the harmless parser embedded in the canonical cancel flow. */
function parseCancelFlags(args: readonly string[]) {
  const parserSection = section(cancel, '### 1. Parse Arguments', '### 2. Detect Active Modes');
  const parser = parserSection.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  if (!parser) throw new Error('Cancellation flag parser missing');
  const output = execFileSync(
    'bash',
    [
      '-c',
      `${parser}\nprintf '{"force":%s,"all":%s,"scope":"%s","graceful":%s}' "$FORCE_MODE" "$ALL_MODE" "$SCOPE" "$GRACEFUL_MODE"`,
      'cancel-flags',
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(output) as {
    force: boolean;
    all: boolean;
    scope: 'current' | 'all';
    graceful: boolean;
  };
}

describe('Team resume contract', () => {
  it('reads and preserves one scoped active run before initialization', () => {
    const read = resume.indexOf('state_read(mode="team", session_id="<current_session_id>")');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(resume.indexOf('deriving a slug'));
    for (const field of ['team_name', 'current_phase', 'fix_loop_count', 'max_fix_loops', 'stage_history']) {
      expect(resume).toContain(`\`${field}\``);
    }
    expect(resume).toContain('handoffs');
    expect(resume).toContain('worker/task/launch-attempt records');
    expect(resume).toContain('duplicate tasks');
    expect(resume).toContain('partial updates');
  });

  it('fails closed on unscoped or corrupt resume state', () => {
    expect(resume).toContain('without `session_id`');
    expect(resume).toContain('legacy/aggregate state');
    expect(resume).toContain('unscoped aggregate response');
    expect(resume).toContain('never infer ownership');
    expect(resume).toMatch(/malformed[\s\S]*unreadable[\s\S]*corrupt/);
    expect(resume).toContain('preserve the original bytes');
  });

  it('keeps all Team state examples session-scoped', () => {
    const calls = [...skill.matchAll(/state_(?:read|write|clear)\(mode="team"[^)]*\)/g)].map(
      ([call]) => call,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.includes('session_id='))).toBe(true);
  });
});

describe('Canonical cancellation contract', () => {
  it('has one matrix and the four independent flag combinations', () => {
    expect(cancel.match(/^## Cancellation Flow$/gm)).toHaveLength(1);
    expect(cancel.match(/^\| Invocation \| Scope \| Shutdown behavior \|$/gm)).toHaveLength(1);
    for (const removed of ['## Scope and Force Execution', '## Implementation Notes', '## Messages Reference']) {
      expect(cancel).not.toContain(removed);
    }
    const rows = [...contract.matchAll(/^\| (no flags|`--force`|`--all`|`--force --all`) \|.*$/gm)].map(
      ([row]) => row,
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('Current session only');
    expect(rows[0]).toContain('Graceful');
    expect(rows[1]).toContain('Current session only');
    expect(rows[1]).toContain('skip graceful waits');
    expect(rows[2]).toContain('Every known session');
    expect(rows[2]).toContain('Normal safe cancellation independently');
    expect(rows[3]).toContain('Every known session');
    expect(rows[3]).toContain('Forced-all');
  });

  it('executes the shipped parser without duplicating its model', () => {
    expect(parseCancelFlags([])).toEqual({ force: false, all: false, scope: 'current', graceful: true });
    expect(parseCancelFlags(['--force'])).toEqual({ force: true, all: false, scope: 'current', graceful: false });
    expect(parseCancelFlags(['--all'])).toEqual({ force: false, all: true, scope: 'all', graceful: true });
    expect(parseCancelFlags(['--force', '--all'])).toEqual({ force: true, all: true, scope: 'all', graceful: false });
    expect(parseCancelFlags(['--all', '--force'])).toEqual(parseCancelFlags(['--force', '--all']));
    expect(parseCancelFlags(['--forcefully', '--alligator'])).toEqual(parseCancelFlags([]));
  });

  it('keeps identity, authorization, and failure gates in the one flow', () => {
    expect(contract).toContain('fails closed');
    expect(flow).toContain('no flags or `--force`');
    expect(flow).toContain('unambiguous current session id');
    expect(flow).toMatch(/never use an aggregate result to\s+infer ownership/);
    expect(flow).toContain('`--all`');
    expect(flow).toContain('failed or unresolved scoped operation');
    expect(flow).toMatch(/blocks the\s+final global pass/);
    const globalGate = flow.indexOf('global pass is allowed only for `--all`');
    const unscopedClear = flow.indexOf('state_clear(mode="<legacy-mode>")');
    expect(globalGate).toBeGreaterThanOrEqual(0);
    expect(globalGate).toBeLessThan(unscopedClear);
    expect(flow.match(/state_clear\(mode="<legacy-mode>"\)/g)).toHaveLength(1);
    expect(flow).toContain('unscoped `state_clear` is not a legacy-only API');
    expect(flow).toContain('uncaptured Team roots remain protected');
  });

  it('keeps the Team-specific safety dependencies', () => {
    expect(flow).toContain('Autopilot (primary first)');
    expect(flow).toContain('stop this session\'s dependent cleanup');
    expect(flow).toMatch(/retain Team\s+runtime records and linked Ralph/);
    expect(flow).toContain('do not use an unscoped clear or fallback');
    expect(flow).toContain('same session id');
    expect(cancel).not.toContain('grep "^omc-team-');
  });
});

describe('Team cancellation delegation', () => {
  it('delegates cancellation instead of defining a second matrix or recipe', () => {
    const cancellationStart = skill.indexOf('## Cancellation\n');
    const cancellationEnd = skill.indexOf('\n## Runtime', cancellationStart);
    const teamCancellation = skill.slice(cancellationStart, cancellationEnd);
    expect(teamCancellation).toContain('skills/cancel/SKILL.md');
    expect(teamCancellation).toContain('flag matrix');
    expect(teamCancellation).toContain('unresolved-session gate');
    expect(teamCancellation).not.toContain('| Invocation |');
    expect(teamCancellation).not.toMatch(/state_(?:read|write|clear)\(/);
    expect(skill).not.toContain('| no flags | Current session only |');
  });

  it('only relaxes waits for both forced invocations', () => {
    const shutdown = section(skill, '### Shutdown Protocol (BLOCKING)', '## CLI Workers');
    expect(shutdown).toContain('`--force`');
    expect(shutdown).toContain('`--force --all`');
    expect(shutdown).toContain('wait-skipping paths');
    expect(shutdown).toContain('honor locks/ownership');
  });

  it('matches the canonical 15-second wait plus 5-second reconciliation', () => {
    const shutdown = section(skill, '### Shutdown Protocol (BLOCKING)', '## CLI Workers');
    expect(shutdown).toContain('wait up to 15 seconds per teammate');
    expect(shutdown).toContain('reconcile for 5 more seconds');
    expect(shutdown).not.toMatch(/30\s*(?:s|seconds)\b/i);
  });
});
