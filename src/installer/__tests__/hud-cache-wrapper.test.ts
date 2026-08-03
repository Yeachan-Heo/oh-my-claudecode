import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const wrapperSource = join(root, 'scripts', 'lib', 'hud-cache-wrapper.sh');

function stageWrapper() {
  const dir = mkdtempSync(join(tmpdir(), 'omc-hud-cache-wrapper-'));
  const hudDir = join(dir, 'hud');
  const cacheDir = join(hudDir, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const wrapperPath = join(hudDir, 'omc-hud-cache.sh');
  const hudPath = join(hudDir, 'omc-hud.mjs');
  writeFileSync(wrapperPath, readFileSync(wrapperSource, 'utf8'), 'utf8');
  chmodSync(wrapperPath, 0o755);
  return { dir, hudDir, cacheDir, wrapperPath, hudPath };
}

const stdinPayload = JSON.stringify({ session_id: 'session-123', cwd: '/tmp', transcript_path: '/tmp/session.jsonl', model: { id: 'claude' } });

describe('HUD cached statusLine launcher', () => {
  it('cached hot path returns the previous render without invoking Node when refresh is locked', () => {
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'CACHED HUD LINE\n');
      mkdirSync(join(staged.cacheDir, 'render.session-123.lock'));

      const nodeMarker = join(staged.dir, 'node-invoked');
      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(nodeMarker)}\nexit 0\n`, 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: stdinPayload,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('CACHED HUD LINE\n');
      expect(existsSync(nodeMarker)).toBe(false);
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('first render renders synchronously so the user never sees the placeholder when stdin is available', () => {
    // Claude Code v2.1.x does not re-poll the statusLine until the user
    // interacts with the pane, so an async first-frame fallback to
    // "[OMC] Starting..." would stay visible until the next keystroke.
    // The wrapper therefore blocks on a synchronous Node render the first
    // time it has stdin but no cached output for the session.
    const staged = stageWrapper();
    try {
      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        join(fakeBin, 'node'),
        '#!/bin/sh\nprintf "FRESH HUD LINE\\n"\n',
        'utf8',
      );
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: stdinPayload,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
          OMC_HUD_SYNC_REFRESH: '1',
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('FRESH HUD LINE\n');
      expect(readFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'utf8')).toBe('FRESH HUD LINE\n');
      expect(readFileSync(join(staged.cacheDir, 'stdin.session-123.json'), 'utf8')).toBe(stdinPayload);
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('falls back to the placeholder when first render has no stdin to render from', () => {
    const staged = stageWrapper();
    try {
      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        join(fakeBin, 'node'),
        '#!/bin/sh\nprintf "FRESH HUD LINE\\n"\n',
        'utf8',
      );
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: '',
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
          OMC_HUD_SYNC_REFRESH: '1',
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('[OMC] Starting...\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('scopes cached output by session_id to avoid cross-session flicker', () => {
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.session-a.txt'), 'SESSION A\n');
      writeFileSync(join(staged.cacheDir, 'statusline.session-b.txt'), 'SESSION B\n');
      mkdirSync(join(staged.cacheDir, 'render.session-a.lock'));
      mkdirSync(join(staged.cacheDir, 'render.session-b.lock'));

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const runForSession = (sessionId: string) => spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: JSON.stringify({ session_id: sessionId, cwd: '/tmp', transcript_path: '/tmp/session.jsonl' }),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 1000,
      });

      expect(runForSession('session-a').stdout).toBe('SESSION A\n');
      expect(runForSession('session-b').stdout).toBe('SESSION B\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });


  it('uses CLAUDE_SESSION_ID when stdin has no session_id', () => {
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.env-session-123.txt'), 'ENV SESSION HUD\n');
      mkdirSync(join(staged.cacheDir, 'render.env-session-123.lock'));

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: JSON.stringify({ cwd: '/tmp/same-worktree', model: { id: 'claude' } }),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          CLAUDE_SESSION_ID: 'env-session-123',
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('ENV SESSION HUD\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('does not collide same-cwd sessions when transcript_path is missing but CLAUDE_SESSION_ID differs', () => {
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.env-session-a.txt'), 'ENV SESSION A\n');
      writeFileSync(join(staged.cacheDir, 'statusline.env-session-b.txt'), 'ENV SESSION B\n');
      mkdirSync(join(staged.cacheDir, 'render.env-session-a.lock'));
      mkdirSync(join(staged.cacheDir, 'render.env-session-b.lock'));

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const runForEnvSession = (sessionId: string) => spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: JSON.stringify({ cwd: '/tmp/same-worktree', model: { id: 'claude' } }),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          CLAUDE_SESSION_ID: sessionId,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 1000,
      });

      expect(runForEnvSession('env-session-a').stdout).toBe('ENV SESSION A\n');
      expect(runForEnvSession('env-session-b').stdout).toBe('ENV SESSION B\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });


  it('uses legacy CLAUDECODE_SESSION_ID when newer env and stdin session_id are absent', () => {
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.legacy-env-session-123.txt'), 'LEGACY ENV SESSION HUD\n');
      mkdirSync(join(staged.cacheDir, 'render.legacy-env-session-123.lock'));

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        CLAUDE_CONFIG_DIR: staged.dir,
        CLAUDECODE_SESSION_ID: 'legacy-env-session-123',
        OMC_HUD_CACHE_DIR: staged.cacheDir,
      };
      delete env.CLAUDE_SESSION_ID;

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: JSON.stringify({ cwd: '/tmp/same-worktree', model: { id: 'claude' } }),
        encoding: 'utf8',
        env,
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('LEGACY ENV SESSION HUD\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('prefers CLAUDE_SESSION_ID over legacy CLAUDECODE_SESSION_ID', () => {
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.new-env-session.txt'), 'NEW ENV SESSION HUD\n');
      writeFileSync(join(staged.cacheDir, 'statusline.legacy-env-session.txt'), 'LEGACY ENV SESSION HUD\n');
      mkdirSync(join(staged.cacheDir, 'render.new-env-session.lock'));
      mkdirSync(join(staged.cacheDir, 'render.legacy-env-session.lock'));

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: JSON.stringify({ cwd: '/tmp/same-worktree', model: { id: 'claude' } }),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          CLAUDE_SESSION_ID: 'new-env-session',
          CLAUDECODE_SESSION_ID: 'legacy-env-session',
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('NEW ENV SESSION HUD\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('forces a synchronous refresh when the model changed since the last recorded marker', () => {
    // Without this, a bare `/model` switch would keep showing the stale
    // cached model line until some unrelated interaction happened to
    // trigger another statusLine call (see hud-cache-wrapper.sh comments).
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'OLD MODEL LINE\n');
      writeFileSync(join(staged.cacheDir, 'model-effort.session-123.txt'), 'claude-old|');

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nprintf "NEW MODEL LINE\\n"\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: stdinPayload,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('NEW MODEL LINE\n');
      expect(readFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'utf8')).toBe('NEW MODEL LINE\n');
      expect(readFileSync(join(staged.cacheDir, 'model-effort.session-123.txt'), 'utf8')).toBe('claude|');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('does not force a synchronous refresh when the model/effort marker is unchanged', () => {
    // Deliberately does NOT pre-hold the render lock: with a held lock, the
    // hot path and the (incorrectly) forced-sync path both degrade to "cat
    // the stale render and exit", making them indistinguishable. Instead,
    // the fake `node` sleeps well past the process timeout. If MODEL_CHANGED
    // were wrongly true here, the wrapper would block on a foreground
    // `refresh_cache` waiting on that sleep and get killed by the timeout —
    // so a clean, on-time exit with the cached content proves the refresh
    // ran only in the background, i.e. the ordinary hot path was taken.
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'CACHED HUD LINE\n');
      writeFileSync(join(staged.cacheDir, 'model-effort.session-123.txt'), 'claude|');

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nsleep 2\nprintf "SHOULD NOT BE SEEN SYNCHRONOUSLY\\n"\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: stdinPayload,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 800,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('CACHED HUD LINE\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('never regresses to a blank placeholder when the model changed but a refresh is already in flight', () => {
    // With the render lock held, a forced synchronous refresh cannot
    // acquire it and must fall back to the last good render — the same
    // externally-observable outcome as the ordinary hot path taking that
    // branch, since neither can spawn `node` while the lock is held. This
    // test cannot distinguish which internal branch produced the output;
    // it locks in the invariant that matters to the user: a model/effort
    // change under lock contention must never show the blank "[OMC]
    // Starting..." placeholder over an existing stale render.
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'OLD MODEL LINE\n');
      writeFileSync(join(staged.cacheDir, 'model-effort.session-123.txt'), 'claude-old|');
      mkdirSync(join(staged.cacheDir, 'render.session-123.lock'));

      const nodeMarker = join(staged.dir, 'node-invoked');
      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(nodeMarker)}\nexit 0\n`, 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: stdinPayload,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('OLD MODEL LINE\n');
      expect(existsSync(nodeMarker)).toBe(false);
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('advances the marker even when the render fails, so repeated renderer failures do not force a synchronous refresh forever', () => {
    // Regression test for a bug where the marker write was nested inside
    // the "render succeeded" guard: a renderer that kept failing (no
    // stdout) would never advance the marker, so MODEL_CHANGED stayed
    // true forever and every single frame blocked on a synchronous,
    // foreground `node` spawn instead of falling back to the cheap hot
    // path once the marker had been recorded.
    const staged = stageWrapper();
    try {
      writeFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'OLD MODEL LINE\n');
      writeFileSync(join(staged.cacheDir, 'model-effort.session-123.txt'), 'claude-old|');

      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      // Always fails (no stdout) and sleeps 2s, so a second *synchronous*
      // spawn on call 2 would be caught by that call's 800ms timeout.
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nsleep 2\nexit 1\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const env = {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        CLAUDE_CONFIG_DIR: staged.dir,
        OMC_HUD_CACHE_DIR: staged.cacheDir,
      };

      // Call 1: model changed, forces a synchronous refresh; the renderer
      // fails (no stdout) but the marker must still advance.
      const first = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: stdinPayload,
        encoding: 'utf8',
        env,
        timeout: 3000,
      });
      expect(first.status).toBe(0);
      expect(first.stdout).toBe('OLD MODEL LINE\n');
      expect(readFileSync(join(staged.cacheDir, 'model-effort.session-123.txt'), 'utf8')).toBe('claude|');

      // Call 2: marker now matches, so this must take the cheap hot path
      // and return well before the fake node's 2s sleep would allow.
      const second = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: stdinPayload,
        encoding: 'utf8',
        env,
        timeout: 800,
      });
      expect(second.status).toBe(0);
      expect(second.stdout).toBe('OLD MODEL LINE\n');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('scopes model id extraction to the model object, ignoring an unrelated bare "id" key elsewhere in the payload', () => {
    // Regression test for the unscoped `extract_json_string id`, whose
    // greedy sed pattern matched the LAST bare "id" key anywhere in the
    // payload. With a decoy "id" after "model" in the JSON, that returned
    // the decoy value instead of the real model id.
    const staged = stageWrapper();
    try {
      const fakeBin = join(staged.dir, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\nprintf "RENDERED\\n"\n', 'utf8');
      chmodSync(join(fakeBin, 'node'), 0o755);

      const decoyPayload = JSON.stringify({
        session_id: 'session-123',
        cwd: '/tmp',
        transcript_path: '/tmp/session.jsonl',
        model: { id: 'claude-real' },
        agent: { id: 'DECOY-ID' },
      });

      const result = spawnSync('sh', [staged.wrapperPath, staged.hudPath], {
        input: decoyPayload,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          CLAUDE_CONFIG_DIR: staged.dir,
          OMC_HUD_CACHE_DIR: staged.cacheDir,
          OMC_HUD_SYNC_REFRESH: '1',
        },
        timeout: 1000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('RENDERED\n');
      expect(readFileSync(join(staged.cacheDir, 'model-effort.session-123.txt'), 'utf8')).toBe('claude-real|');
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });
});
