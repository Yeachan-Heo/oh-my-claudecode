import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SESSION_LIB = join(process.cwd(), 'skills', 'project-session-manager', 'lib', 'session.sh');
const CONFIG_LIB = join(process.cwd(), 'skills', 'project-session-manager', 'lib', 'config.sh');

function runShell(script: string, home: string): string {
  return execFileSync('bash', ['-lc', script], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
    },
  }).trim();
}

describe('project-session-manager session filtering', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns only active review/fix sessions for cleanup scans', () => {
    const home = mkdtempSync(join(tmpdir(), 'omc-psm-sessions-'));
    tempDirs.push(home);
    const psmRoot = join(home, '.psm');
    mkdirSync(psmRoot, { recursive: true });

    writeFileSync(
      join(psmRoot, 'sessions.json'),
      JSON.stringify(
        {
          version: 1,
          sessions: {
            'repo:pr-101': {
              id: 'repo:pr-101',
              type: 'review',
              project: 'repo',
              state: 'active',
              metadata: { pr_number: 101 },
            },
            'repo:pr-102': {
              id: 'repo:pr-102',
              type: 'review',
              project: 'repo',
              state: 'completed',
              metadata: { pr_number: 102 },
            },
            'repo:issue-201': {
              id: 'repo:issue-201',
              type: 'fix',
              project: 'repo',
              state: 'active',
              metadata: { issue_number: 201 },
            },
            'repo:issue-202': {
              id: 'repo:issue-202',
              type: 'fix',
              project: 'repo',
              state: 'killed',
              metadata: { issue_number: 202 },
            },
          },
          stats: { total_created: 4, total_cleaned: 2 },
        },
        null,
        2,
      ),
    );

    const reviews = runShell(
      `source "${CONFIG_LIB}"; source "${SESSION_LIB}"; psm_get_review_sessions`,
      home,
    );
    const fixes = runShell(
      `source "${CONFIG_LIB}"; source "${SESSION_LIB}"; psm_get_fix_sessions`,
      home,
    );

    expect(reviews).toBe('repo:pr-101|101|repo');
    expect(fixes).toBe('repo:issue-201|201|repo');
  });
});
