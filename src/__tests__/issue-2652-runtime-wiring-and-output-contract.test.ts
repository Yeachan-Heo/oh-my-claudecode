import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { ULTRAWORK_MESSAGE } from '../installer/hooks.js';
import { getUltraworkMessage } from '../hooks/keyword-detector/ultrawork/index.js';

describe('issue #2652 runtime wiring and output contract', () => {
  it('ships the Stop hook through persistent-mode.mjs', () => {
    const hooksJsonPath = join(process.cwd(), 'hooks', 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };

    const stopCommands = (hooks.hooks?.Stop ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command ?? '');

    expect(stopCommands.some((command) => command.includes('/scripts/persistent-mode.mjs'))).toBe(true);
    const persistentModePath = join(process.cwd(), 'scripts', 'persistent-mode.mjs');
    const persistentModeSource = readFileSync(persistentModePath, 'utf-8');

    expect(persistentModeSource).toContain('session-idle');
    expect(persistentModeSource).toContain('dispatchIdleNotificationInBackground');
    expect(persistentModeSource).toContain('recordIdleNotificationSent');
    expect(stopCommands.some((command) => command.includes('/scripts/persistent-mode.cjs'))).toBe(false);
  });

  it('dispatches session-idle from persistent-mode.mjs Stop hook path', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omc-session-idle-'));
    try {
      const pluginRoot = join(tempRoot, 'plugin');
      const projectRoot = join(tempRoot, 'project');
      const markerPath = join(tempRoot, 'idle-marker.json');
      mkdirSync(join(pluginRoot, 'dist', 'notifications'), { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(
        join(pluginRoot, 'dist', 'notifications', 'index.js'),
        `export async function notify(event, payload) {\n` +
          `  await import('node:fs').then(({ writeFileSync }) => writeFileSync(process.env.IDLE_MARKER_PATH, JSON.stringify({ event, payload })));\n` +
          `}\n`,
      );

      execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'persistent-mode.mjs')], {
        input: JSON.stringify({ cwd: projectRoot, session_id: 'session-idle-test' }),
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          HOME: join(tempRoot, 'home'),
          OMC_STATE_DIR: join(tempRoot, 'state'),
          IDLE_MARKER_PATH: markerPath,
        },
      });

      const deadline = Date.now() + 2000;
      while (!existsSync(markerPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
        event: string;
        payload: { sessionId: string; projectPath: string };
      };
      expect(marker).toEqual({
        event: 'session-idle',
        payload: {
          sessionId: 'session-idle-test',
          projectPath: projectRoot,
        },
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('ultrawork mode instructs spawned agents to keep outputs concise', () => {
    expect(ULTRAWORK_MESSAGE).toBe(getUltraworkMessage());
    expect(ULTRAWORK_MESSAGE).toContain('CONCISE OUTPUTS');
    expect(ULTRAWORK_MESSAGE).toContain('under 100 words');
    expect(ULTRAWORK_MESSAGE).toContain('files touched');
    expect(ULTRAWORK_MESSAGE).toContain('verification status');
  });
});
