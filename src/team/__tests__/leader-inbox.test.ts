import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  leaderInboxPath,
  ensureLeaderInbox,
  appendToLeaderInbox,
  extendLeaderBootstrapPrompt,
} from '../leader-inbox.js';

const TEST_CWD = join(tmpdir(), `omc-test-leader-inbox-${process.pid}`);
const TEST_TEAM = 'my-team';

beforeEach(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_CWD, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// leaderInboxPath — pure, path correctness, sanitization
// ---------------------------------------------------------------------------

describe('leaderInboxPath', () => {
  it('returns correct path under cwd', () => {
    const p = leaderInboxPath(TEST_TEAM, TEST_CWD);
    expect(p).toBe(join(TEST_CWD, '.omc/state/team/my-team/leader/inbox.md'));
  });

  it('sanitizes team name (strips special chars)', () => {
    // sanitizeName strips non-alphanumeric/dash/underscore chars
    const p = leaderInboxPath('my team!', TEST_CWD);
    expect(p).not.toContain('!');
    expect(p).not.toContain(' ');
    expect(p).toContain('leader/inbox.md');
  });

  it('prevents traversal via team name: dots and slashes stripped', () => {
    // sanitizeName turns '../../../etc' into 'etc', so path stays under cwd
    const p = leaderInboxPath('../../../etc', TEST_CWD);
    expect(p).not.toContain('..');
    expect(p.startsWith(TEST_CWD)).toBe(true);
  });

  it('is pure: same input → same output', () => {
    expect(leaderInboxPath(TEST_TEAM, TEST_CWD)).toBe(leaderInboxPath(TEST_TEAM, TEST_CWD));
  });
});

// ---------------------------------------------------------------------------
// ensureLeaderInbox
// ---------------------------------------------------------------------------

describe('ensureLeaderInbox', () => {
  it('creates the leader directory', async () => {
    await ensureLeaderInbox(TEST_TEAM, TEST_CWD);
    const dir = join(TEST_CWD, '.omc/state/team/my-team/leader');
    expect(existsSync(dir)).toBe(true);
  });

  it('creates inbox.md with header content', async () => {
    const path = await ensureLeaderInbox(TEST_TEAM, TEST_CWD);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# Leader Inbox');
  });

  it('returns the absolute path to inbox.md', async () => {
    const path = await ensureLeaderInbox(TEST_TEAM, TEST_CWD);
    expect(path).toBe(leaderInboxPath(TEST_TEAM, TEST_CWD));
  });

  it('is idempotent: calling twice does not throw or overwrite content', async () => {
    const path = await ensureLeaderInbox(TEST_TEAM, TEST_CWD);
    // Append something to verify it isn't overwritten
    const { appendFileSync } = await import('fs');
    appendFileSync(path, '\n\n---\nextra content', 'utf-8');

    // Call again — should not overwrite
    await ensureLeaderInbox(TEST_TEAM, TEST_CWD);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('extra content');
  });

  it('path is within cwd (no traversal)', async () => {
    const path = await ensureLeaderInbox(TEST_TEAM, TEST_CWD);
    const realCwd = realpathSync(TEST_CWD);
    expect(path.startsWith(realCwd) || path.startsWith(TEST_CWD)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendToLeaderInbox
// ---------------------------------------------------------------------------

describe('appendToLeaderInbox', () => {
  it('appends message with \\n\\n---\\n separator', async () => {
    await appendToLeaderInbox(TEST_TEAM, 'hello leader', TEST_CWD);
    const path = leaderInboxPath(TEST_TEAM, TEST_CWD);
    const content = readFileSync(path, 'utf-8');
    expect(content).toBe('\n\n---\nhello leader');
  });

  it('uses same delimiter as worker-bootstrap appendToInbox', async () => {
    // The delimiter is exactly `\n\n---\n` — verify character-for-character
    await appendToLeaderInbox(TEST_TEAM, 'msg', TEST_CWD);
    const path = leaderInboxPath(TEST_TEAM, TEST_CWD);
    const content = readFileSync(path, 'utf-8');
    expect(content.startsWith('\n\n---\n')).toBe(true);
  });

  it('appends multiple messages sequentially', async () => {
    await appendToLeaderInbox(TEST_TEAM, 'first', TEST_CWD);
    await appendToLeaderInbox(TEST_TEAM, 'second', TEST_CWD);
    const path = leaderInboxPath(TEST_TEAM, TEST_CWD);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('first');
    expect(content).toContain('second');
    // Two separators
    const separatorCount = (content.match(/\n\n---\n/g) ?? []).length;
    expect(separatorCount).toBe(2);
  });

  it('creates parent directories if missing', async () => {
    // Fresh cwd with no pre-existing dirs
    const freshCwd = join(tmpdir(), `omc-test-leader-inbox-fresh-${process.pid}`);
    try {
      mkdirSync(freshCwd, { recursive: true });
      await appendToLeaderInbox('newteam', 'msg', freshCwd);
      const path = leaderInboxPath('newteam', freshCwd);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(freshCwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extendLeaderBootstrapPrompt
// ---------------------------------------------------------------------------

describe('extendLeaderBootstrapPrompt', () => {
  it('contains the canonical leader inbox path', () => {
    const prompt = extendLeaderBootstrapPrompt(TEST_TEAM);
    expect(prompt).toContain('.omc/state/team/my-team/leader/inbox.md');
  });

  it('contains "check this file" instruction', () => {
    const prompt = extendLeaderBootstrapPrompt(TEST_TEAM);
    expect(prompt.toLowerCase()).toContain('check this file');
  });

  it('is pure: same input → same output', () => {
    expect(extendLeaderBootstrapPrompt(TEST_TEAM)).toBe(
      extendLeaderBootstrapPrompt(TEST_TEAM)
    );
  });

  it('sanitizes team name in the path', () => {
    const prompt = extendLeaderBootstrapPrompt('my team!');
    // The prompt sentence contains spaces (natural language), but the embedded
    // team-name segment of the path must not contain '!' or spaces.
    expect(prompt).not.toContain('!');
    // Extract the path segment from the prompt and verify no spaces in it
    const pathMatch = prompt.match(/\.omc\/state\/team\/([^/]+)\/leader\/inbox\.md/);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]).not.toContain('!');
    expect(pathMatch![1]).not.toContain(' ');
  });

  it('path in prompt matches leaderInboxPath relative segment', () => {
    const prompt = extendLeaderBootstrapPrompt(TEST_TEAM);
    const fullPath = leaderInboxPath(TEST_TEAM, TEST_CWD);
    // The prompt uses relative path; fullPath has cwd prefix
    const relSegment = `.omc/state/team/my-team/leader/inbox.md`;
    expect(fullPath).toContain(relSegment);
    expect(prompt).toContain(relSegment);
  });
});
