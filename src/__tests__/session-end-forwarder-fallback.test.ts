import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * B5 regression: the session-end forwarder's bridge fallback must never
 * silently no-op. When the resolved bridge entry dispatches, the payload and
 * --hook=session-end reach it; when the forward fails (missing command,
 * non-zero exit), the forwarder stays best-effort (exit 0) but reports the
 * lost chain enqueue loudly on stderr.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const FORWARDER = join(REPO_ROOT, 'templates', 'hooks', 'session-end.mjs');

const RECORDING_BRIDGE = `\
const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_BRIDGE_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString('utf8'),
  }));
  if (process.env.FAKE_BRIDGE_EXIT) process.exit(Number(process.env.FAKE_BRIDGE_EXIT));
});
`;

interface Fixture {
  root: string;
  pluginRoot: string;
  recordFile: string;
  env: NodeJS.ProcessEnv;
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'omc-session-end-forwarder-'));
  const pluginRoot = join(root, 'plugin-root');
  const recordFile = join(root, 'bridge-record.json');
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(join(pluginRoot, 'bridge', 'cli.cjs'), RECORDING_BRIDGE);

  const env: Record<string, string | undefined> = { ...process.env };
  env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  env.OMC_STATE_DIR = join(root, 'state-root');
  env.OMC_DISABLE_MULTIREPO = '1';
  env.FAKE_BRIDGE_RECORD = recordFile;
  delete env.FAKE_BRIDGE_EXIT;

  return { root, pluginRoot, recordFile, env: env as NodeJS.ProcessEnv };
}

/**
 * Plant a factory chain ledger at the state root the forwarder will resolve
 * for the payload cwd. Resolution is env-dependent (git availability, path
 * casing), so the ledger is planted under the fixture's exact env — the same
 * env the forwarder subprocess receives.
 */
async function plantLedger(fixture: Fixture): Promise<void> {
  const saved: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(fixture.env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const { resolveOmcStateRoot } = await import(
      join(REPO_ROOT, 'templates', 'hooks', 'lib', 'state-root.mjs')
    );
    const factoryDir = join(
      await resolveOmcStateRoot(join(fixture.root, 'project')),
      'state',
      'factory',
    );
    mkdirSync(factoryDir, { recursive: true });
    writeFileSync(join(factoryDir, 'chain-test-session.json'), '{}');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

function runForwarder(fixture: Fixture): { status: number; stdout: string; stderr: string } {
  const payload = JSON.stringify({
    session_id: 'test-session',
    transcript_path: '',
    cwd: join(fixture.root, 'project'),
    hook_event_name: 'SessionEnd',
    reason: 'prompt_input_exit',
  });
  const result = spawnSync(process.execPath, [FORWARDER], {
    input: payload,
    encoding: 'utf-8',
    timeout: 20000,
    windowsHide: true,
    env: fixture.env,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('session-end forwarder bridge fallback (B5)', () => {
  it('dispatches the payload with --hook=session-end to the resolved bridge entry', async () => {
    const fixture = await makeFixture();
    await plantLedger(fixture);
    try {
      const { stderr } = runForwarder(fixture);
      expect(existsSync(fixture.recordFile)).toBe(true);
      const recorded = JSON.parse(readFileSync(fixture.recordFile, 'utf-8')) as {
        argv: string[];
        stdin: string;
      };
      expect(recorded.argv).toContain('--hook=session-end');
      expect(JSON.parse(recorded.stdin).session_id).toBe('test-session');
      expect(stderr).not.toContain('[omc session-end] bridge forward FAILED');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports a failing bridge loudly on stderr while still exiting 0', async () => {
    const fixture = await makeFixture();
    fixture.env.FAKE_BRIDGE_EXIT = '3';
    await plantLedger(fixture);
    try {
      const { stderr } = runForwarder(fixture);
      expect(stderr).toContain('[omc session-end] bridge forward FAILED');
      expect(stderr).toContain('exit status 3');
      expect(stderr).toContain('--hook=session-end');
      expect(stderr).toContain(join(fixture.pluginRoot, 'bridge', 'cli.cjs'));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports a missing bridge command loudly on stderr while still exiting 0', async () => {
    const fixture = await makeFixture();
    // No plugin bridge present: drop CLAUDE_PLUGIN_ROOT so the fallback lands
    // on `omc-cli`, and strip PATH so the command cannot resolve.
    delete fixture.env.CLAUDE_PLUGIN_ROOT;
    fixture.env.PATH = '';
    await plantLedger(fixture);
    try {
      const { stderr } = runForwarder(fixture);
      expect(stderr).toContain('[omc session-end] bridge forward FAILED');
      expect(stderr).toContain('omc-cli');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
