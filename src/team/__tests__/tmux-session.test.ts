import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { sanitizeName, sessionName, createSession, killSession } from '../tmux-session.js';

describe('sanitizeName', () => {
  it('passes alphanumeric names', () => {
    expect(sanitizeName('worker1')).toBe('worker1');
  });

  it('removes invalid characters', () => {
    expect(sanitizeName('worker@1!')).toBe('worker1');
  });

  it('allows hyphens', () => {
    expect(sanitizeName('my-worker')).toBe('my-worker');
  });

  it('truncates to 50 chars', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeName(long).length).toBe(50);
  });

  it('throws for all-invalid names', () => {
    expect(() => sanitizeName('!!!@@@')).toThrow('no valid characters');
  });

  it('rejects 1-char result after sanitization', () => {
    expect(() => sanitizeName('a')).toThrow('too short');
  });

  it('accepts 2-char result after sanitization', () => {
    expect(sanitizeName('ab')).toBe('ab');
  });
});

describe('sessionName', () => {
  it('builds correct session name', () => {
    expect(sessionName('myteam', 'codex1')).toBe('omc-team-myteam-codex1');
  });

  it('sanitizes both parts', () => {
    expect(sessionName('my team!', 'work@er')).toBe('omc-team-myteam-worker');
  });
});

// ---------------------------------------------------------------------------
// Leader pane guard tests (#723)
// ---------------------------------------------------------------------------
// These tests verify that createSession / killSession never touch the tmux
// session the current process (team leader) is running inside.
//
// We spy on the `child_process` module's `execFileSync` at the module level
// (avoiding top-level variables inside vi.mock factories, which would cause
// ReferenceError due to hoisting).
// ---------------------------------------------------------------------------

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual };
});

describe('leader pane guard (issue #723)', () => {
  let execFileSyncSpy: ReturnType<typeof vi.spyOn>;
  const originalTmux = process.env.TMUX;

  beforeEach(async () => {
    const cp = await import('child_process');
    execFileSyncSpy = vi.spyOn(cp, 'execFileSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  });

  it('killSession is a no-op when target matches the current leader session', () => {
    // Simulate being inside the session we are about to kill
    process.env.TMUX = '/tmp/tmux-test/default,1234,0';

    execFileSyncSpy.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (cmd === 'tmux' && a.includes('display-message')) {
        // Leader session name = same as target
        return 'omc-team-myteam-myworker' as any;
      }
      if (cmd === 'tmux' && a.includes('kill-session')) {
        throw new Error('kill-session called for leader session — guard failed!');
      }
      return '' as any;
    });

    // Should NOT throw — the guard must intercept before kill-session
    expect(() => killSession('myteam', 'myworker')).not.toThrow();
    const killCalls = execFileSyncSpy.mock.calls.filter(
      ([, args]) => Array.isArray(args) && (args as string[]).includes('kill-session')
    );
    expect(killCalls).toHaveLength(0);
  });

  it('killSession proceeds when target differs from the current leader session', () => {
    process.env.TMUX = '/tmp/tmux-test/default,1234,0';

    const killedSessions: string[] = [];

    execFileSyncSpy.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (cmd === 'tmux' && a.includes('display-message')) {
        return 'omc-team-myteam-leader' as any; // different session = leader
      }
      if (cmd === 'tmux' && a.includes('kill-session')) {
        killedSessions.push(a[a.indexOf('-t') + 1]);
      }
      return '' as any;
    });

    killSession('myteam', 'myworker');
    expect(killedSessions).toContain('omc-team-myteam-myworker');
  });

  it('createSession skips kill-session when target matches the current leader session', () => {
    process.env.TMUX = '/tmp/tmux-test/default,1234,0';

    const killedSessions: string[] = [];
    const createdSessions: string[] = [];

    execFileSyncSpy.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[];
      if (cmd === 'tmux' && a.includes('display-message')) {
        return 'omc-team-myteam-myworker' as any;
      }
      if (cmd === 'tmux' && a.includes('kill-session')) {
        killedSessions.push(a[a.indexOf('-t') + 1]);
      }
      if (cmd === 'tmux' && a.includes('new-session')) {
        createdSessions.push(a[a.indexOf('-s') + 1]);
      }
      return '' as any;
    });

    createSession('myteam', 'myworker');

    // kill-session must NOT have been called for the leader's own session
    expect(killedSessions).not.toContain('omc-team-myteam-myworker');
    // new-session must still be called (the session is created as normal)
    expect(createdSessions).toContain('omc-team-myteam-myworker');
  });

  it('killSession proceeds normally when not inside tmux (TMUX env absent)', () => {
    delete process.env.TMUX;

    const killedSessions: string[] = [];

    execFileSyncSpy.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[];
      // display-message should not even be called (early return when TMUX absent)
      if (cmd === 'tmux' && a.includes('kill-session')) {
        killedSessions.push(a[a.indexOf('-t') + 1]);
      }
      return '' as any;
    });

    killSession('myteam', 'myworker');
    expect(killedSessions).toContain('omc-team-myteam-myworker');
  });
});

// NOTE: createSession, killSession require tmux to be installed.
// Gate with: describe.skipIf(!hasTmux)('tmux integration', () => { ... })

function hasTmux(): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('tmux -V', { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch { return false; }
}

describe.skipIf(!hasTmux())('createSession with workingDirectory', () => {

  it('accepts optional workingDirectory param', () => {
    // Should not throw — workingDirectory is optional
    const name = createSession('tmuxtest', 'wdtest', '/tmp');
    expect(name).toBe('omc-team-tmuxtest-wdtest');
    killSession('tmuxtest', 'wdtest');
  });

  it('works without workingDirectory param', () => {
    const name = createSession('tmuxtest', 'nowd');
    expect(name).toBe('omc-team-tmuxtest-nowd');
    killSession('tmuxtest', 'nowd');
  });
});
