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

      const start = Date.now();
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
      const elapsedMs = Date.now() - start;

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('CACHED HUD LINE\n');
      expect(existsSync(nodeMarker)).toBe(false);
      expect(elapsedMs).toBeLessThan(100);
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
    }
  });

  it('first render prints a nonblank placeholder and refreshes the cache from Node', () => {
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
      expect(result.stdout).toBe('[OMC] Starting...\n');
      expect(readFileSync(join(staged.cacheDir, 'statusline.session-123.txt'), 'utf8')).toBe('FRESH HUD LINE\n');
      expect(readFileSync(join(staged.cacheDir, 'stdin.session-123.json'), 'utf8')).toBe(stdinPayload);
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

});
