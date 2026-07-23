import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const templatePath = join(process.cwd(), 'templates', 'hooks', 'session-end.mjs');

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('standalone SessionEnd Graph settlement hook', () => {
  it('is bounded, shell-free, and delegates mutations to the Graph CLI', () => {
    const source = readFileSync(templatePath, 'utf8');
    expect(source).toContain("spawnSync('omc'");
    expect(source).toContain("'settle-session'");
    expect(source).toContain('shell: false');
    expect(source).toContain('timeout: SETTLE_TIMEOUT_MS');
    expect(source).not.toContain('writeFileSync');
    expect(source).not.toContain('unlinkSync');
  });

  it('allows SessionEnd without invoking the CLI when Graph state is absent', () => {
    const project = temporaryRoot('omc-session-end-no-graph-');
    mkdirSync(join(project, '.git'), { recursive: true });

    const output = execFileSync(process.execPath, [templatePath], {
      cwd: project,
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'session-1', cwd: project }),
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();

    expect(JSON.parse(output)).toEqual({ continue: true, suppressOutput: true });
  });

  it('passes stable, non-shell arguments to the CLI for existing Graph state', () => {
    const project = temporaryRoot('omc-session-end-graph-');
    const binDir = temporaryRoot('omc-session-end-bin-');
    const capturePath = join(project, 'captured-args.txt');
    const graphPath = join(project, '.omc', 'state', 'sessions', 'session-1', 'graph-state.json');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(graphPath, '..'), { recursive: true });
    writeFileSync(graphPath, '{}');

    // Cross-platform fake `omc` that captures its argv to a file. On Unix it
    // is a /bin/sh script; on Windows a .cmd wrapper is required because
    // spawnSync('omc', ..., { shell: false }) resolves via PATHEXT.
    if (process.platform === 'win32') {
      writeFileSync(join(binDir, 'omc.cmd'), `@echo off\r\nnode -e "require('fs').writeFileSync(process.env.OMC_GRAPH_CAPTURE, process.argv.slice(1).join('\\n')+'\\n')" %*\r\n`);
    } else {
      const fakeOmc = join(binDir, 'omc');
      writeFileSync(fakeOmc, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMC_GRAPH_CAPTURE"\n');
      chmodSync(fakeOmc, 0o755);
    }

    const output = execFileSync(process.execPath, [templatePath], {
      cwd: project,
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'session-1', cwd: project }),
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        OMC_GRAPH_CAPTURE: capturePath,
      },
    }).trim();

    expect(JSON.parse(output)).toEqual({ continue: true, suppressOutput: true });
    expect(existsSync(capturePath)).toBe(true);
    const args = readFileSync(capturePath, 'utf8').trim().split('\n');
    expect(args.slice(0, 7)).toEqual([
      'graph',
      'settle-session',
      '--session-id',
      'session-1',
      '--driver-id',
      'session-end',
      '--transition-id',
    ]);
    expect(args[7]).toMatch(/^session-end:[a-f0-9]{32}$/);
    expect(args[8]).toBe('--json');
  });
});
