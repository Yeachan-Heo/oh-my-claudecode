import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getProcessStartIdentitySync, isProcessIdentityLive } from '../../platform/process-utils.js';
import { buildWindowsSupervisorInvocation, buildWindowsSupervisorSource, type WorkerLaunchBootstrapSpec } from '../worker-launch-ack.js';

const tmux = process.env.OMC_WINDOWS_TEST_TMUX_BINARY;
const enabled = process.platform === 'win32' && Boolean(tmux && existsSync(tmux));
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'windows-supervisor-runtime.mjs');
const protocol = 'worker-launch-windows-supervisor-v1';
type Frame = { kind: string; pid: number; instance_id: string; attempt_id: string; authority_digest: string; containment_nonce: string; process_start_identity?: string; cleanup_verified?: boolean; exit_code?: number; outcome?: string; protocol: string };
type State = { supervisorPid: number; controllerPid: number; stdout: string; stderr: string; frames: Frame[]; errors: { stream: string; code?: string }[]; commands: number[]; closed: boolean; exitCode?: number; partialStdout?: string };
type Provider = { pid: number; descendantPid?: number; tty: boolean[] };

async function json<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

async function waitFor<T>(read: () => Promise<T | null>, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Windows supervisor runtime timeout: ${label}`);
}

async function run(mode: 'exit' | 'terminate' | 'eof'): Promise<void> {
  // A unique data directory and -L socket keep this entirely outside any
  // existing psmux server. Retain artifacts even on failure for diagnosis.
  const root = await mkdtemp(join(process.env.TEMP ?? tmpdir(), 'omc-windows-supervisor-'));
  const socket = `omc-runtime-${randomUUID()}`;
  const environment: NodeJS.ProcessEnv = { ...process.env, PSMUX_DATA_DIR: join(root, 'psmux'), TEMP: root, TMP: root };
  for (const key of Object.keys(environment)) {
    if (key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('PSMUX_') && key !== 'PSMUX_DATA_DIR') delete environment[key];
  }
  await mkdir(environment.PSMUX_DATA_DIR!, { recursive: true });
  await writeFile(join(root, 'psmux.conf'), 'set -g remain-on-exit on\n');
  const providerEnvironment = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root };
  const identity = {
    schema_version: 1 as const, attempt_id: randomUUID(), nonce: randomUUID(), instance_id: randomUUID(),
    team_name: 'windows-runtime-test', worker_name: 'worker-1', pane_id: '%0', provider: 'codex' as const, created_at: new Date().toISOString(),
  };
  const spec: WorkerLaunchBootstrapSpec = {
    ...identity, current_path: join(root, 'current.json'), expected_path: join(root, 'expected.json'), ack_path: join(root, 'ack.json'),
    decision_path: join(root, 'decision.json'), started_path: join(root, 'started.json'), transport_owner_path: join(root, 'owner.json'),
    bootstrap_descriptor_path: join(root, 'bootstrap.json'), wrapper_path: join(root, 'wrapper.cmd'), transport_cleanup_complete_path: join(root, 'cleanup.json'),
    provider_argv: [process.execPath, fixture, 'provider', root, mode], provider_env: {}, cwd: root,
    decision_timeout_ms: 15_000, release_after_spawn: false, containment_nonce: randomUUID(), authority_digest: '',
    supervisor_source_sha256: createHash('sha256').update(buildWindowsSupervisorSource()).digest('hex'),
  };
  // Explicit synthetic authority follows the production canonical field order;
  // invocation and stdinPayload are then generated normally, without edits.
  spec.authority_digest = createHash('sha256').update(JSON.stringify({
    protocol: 'worker-launch-authority-v1', nonce: spec.containment_nonce, supervisor_source_sha256: spec.supervisor_source_sha256,
    identity, provider_argv: spec.provider_argv, provider_env: {}, cwd: root,
  })).digest('hex');
  const invocation = buildWindowsSupervisorInvocation(spec, providerEnvironment);
  expect(invocation.command.length + invocation.args.join(' ').length + 16).toBeLessThan(32_767);
  await writeFile(join(root, 'invocation.json'), JSON.stringify({ invocation: { command: invocation.command, args: invocation.args, stdinPayload: invocation.stdinPayload }, environment: providerEnvironment }));
  const command = (...args: string[]) => execFileSync(tmux!, ['-L', socket, '-f', join(root, 'psmux.conf'), ...args], {
    env: environment, cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  const owned: { pid: number; identity: string }[] = [];
  const capture = (pid: number) => {
    const startIdentity = getProcessStartIdentitySync(pid);
    expect(startIdentity, `creation identity for ${pid}`).toBeTruthy();
    owned.push({ pid, identity: startIdentity! });
    return startIdentity;
  };
  let started = false;
  try {
    command('new-session', '-d', '-s', 'runtime', '--', process.execPath, fixture, 'controller', root, mode);
    started = true;
    const initial = await waitFor(() => json<State>(join(root, 'controller.json')), 'controller started');
    capture(initial.supervisorPid);
    capture(initial.controllerPid);
    const readyState = await waitFor(async () => {
      const value = await json<State>(join(root, 'controller.json'));
      return value?.frames.some(frame => frame.kind === 'ready') ? value : null;
    }, 'ready frame');
    const ready = readyState.frames.find(frame => frame.kind === 'ready')!;
    expect(ready).toMatchObject({ protocol, attempt_id: identity.attempt_id, instance_id: identity.instance_id, authority_digest: spec.authority_digest, containment_nonce: spec.containment_nonce });
    expect(capture(ready.pid)).toBe(ready.process_start_identity);
    const provider = await waitFor(() => json<Provider>(join(root, 'provider.json')), 'native provider console');
    expect(provider.tty).toEqual([true, true, true]);
    expect(provider.pid).toBe(ready.pid);
    if (provider.descendantPid) capture(provider.descendantPid);
    await writeFile(join(root, 'identities.json'), JSON.stringify(owned));
    const frame = { protocol, kind: 'terminate', attempt_id: identity.attempt_id, instance_id: identity.instance_id, authority_digest: spec.authority_digest, containment_nonce: spec.containment_nonce };
    if (mode === 'exit') await writeFile(join(root, 'exit-provider'), 'exit');
    if (mode === 'terminate') {
      await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: 0, frame: { ...frame, instance_id: randomUUID() } }));
      await waitFor(async () => {
        const value = await json<State>(join(root, 'controller.json'));
        return value?.commands.includes(0) ? value : null;
      }, 'wrong instance command sent');
      await new Promise(resolve => setTimeout(resolve, 500));
      const afterWrong = await json<State>(join(root, 'controller.json'));
      expect(afterWrong?.closed).toBe(false);
      expect(afterWrong?.frames.some(value => value.kind === 'terminal')).toBe(false);
      expect(await isProcessIdentityLive(provider.pid, ready.process_start_identity!)).toBe('live');
      await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: 1, frame }));
    }
    if (mode === 'eof') await writeFile(join(root, 'command.json'), JSON.stringify({ sequence: 0, operation: 'eof' }));
    const closed = await waitFor(async () => {
      const value = await json<State>(join(root, 'controller.json'));
      return value?.closed ? value : null;
    }, 'supervisor closed');
    expect(closed.stdout).not.toContain('WINDOWS_SUPERVISOR_CONSOLE_MARKER');
    expect(closed.stdout).not.toContain('WINDOWS_SUPERVISOR_STDERR_MARKER');
    expect(closed.partialStdout).toBe('');
    expect(closed.errors).toEqual([]);
    const terminal = closed.frames.find(value => value.kind === 'terminal');
    if (mode === 'eof') {
      expect(terminal).toBeUndefined();
      expect(closed.exitCode).not.toBe(0);
      expect(closed.stderr).toContain('worker_launch_authority_lost');
    } else {
      expect(terminal).toMatchObject({ protocol, attempt_id: identity.attempt_id, instance_id: identity.instance_id, authority_digest: spec.authority_digest, containment_nonce: spec.containment_nonce, pid: provider.pid, cleanup_verified: true, outcome: mode === 'exit' ? 'exit' : 'terminated' });
      expect(terminal?.exit_code).toBe(mode === 'exit' ? 7 : 1);
      expect(closed.exitCode).toBe(0);
    }
    await writeFile(join(root, 'pane.txt'), command('capture-pane', '-p', '-t', 'runtime:0.0'));
    const pane = await readFile(join(root, 'pane.txt'), 'utf8');
    expect(pane).toContain('WINDOWS_SUPERVISOR_CONSOLE_MARKER');
    expect(pane).toContain('WINDOWS_SUPERVISOR_STDERR_MARKER');
  } finally {
    if (started) command('kill-server');
    for (const processIdentity of owned) {
      await waitFor(async () => ['dead', 'mismatch'].includes(await isProcessIdentityLive(processIdentity.pid, processIdentity.identity)) ? true : null, `owned process ${processIdentity.pid} gone`, 5000);
    }
    console.info(`Windows supervisor artifacts retained: ${root}`);
  }
}

describe('Windows supervisor in an isolated psmux console', () => {
  it.runIf(enabled)('keeps native console stdio separate from protocol and reports exit 7', () => run('exit'), 60_000);
  it.runIf(enabled)('ignores another instance and terminates the exact provider tree', () => run('terminate'), 60_000);
  it.runIf(enabled)('kills its tree on control EOF without reporting successful completion', () => run('eof'), 60_000);
});
