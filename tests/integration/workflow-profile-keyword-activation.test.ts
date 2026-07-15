import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const hooks = [
  join(root, 'scripts', 'keyword-detector.mjs'),
  join(root, 'templates', 'hooks', 'keyword-detector.mjs'),
];
const created: string[] = [];
const sessionId = 'named-activation-fence';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'keyword-activation-'));
  created.push(directory);
  const statePath = join(directory, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
  mkdirSync(join(statePath, '..'), { recursive: true });
  const namedState = {
    active: true,
    phase: 'executing',
    session_id: sessionId,
    workflowRunId: '11111111-1111-4111-8111-111111111111',
    workflow: { workflowName: 'default', stages: ['plan', 'execute'] },
    pipelineTracking: { currentStageIndex: 1, trackingRevision: 4 },
    original_prompt: 'named workflow task',
  };
  writeFileSync(statePath, JSON.stringify(namedState, null, 2));
  return { directory, statePath };
}

function invoke(hook: string, directory: string, prompt: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [hook], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        CLAUDE_CONFIG_DIR: join(directory, '.claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${hook} exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd: directory,
      session_id: sessionId,
      prompt,
      transcript_path: join(directory, `${randomUUID()}.jsonl`),
    }));
  });
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe.each(hooks)('keyword autopilot activation fence (%s)', hook => {
  it('preserves an active named descriptor byte-for-byte when legacy autopilot activates', async () => {
    const f = fixture();
    const before = readFileSync(f.statePath, 'utf8');

    await invoke(hook, f.directory, 'autopilot build a legacy tool');

    expect(readFileSync(f.statePath, 'utf8')).toBe(before);
    expect(existsSync(`${f.statePath}.mutation.lock`)).toBe(false);
  });

  it('serializes concurrent legacy activation attempts behind an active named descriptor', async () => {
    const f = fixture();
    const before = readFileSync(f.statePath, 'utf8');

    await Promise.all([
      invoke(hook, f.directory, 'autopilot build a legacy tool'),
      invoke(hook, f.directory, 'autopilot build another legacy tool'),
    ]);

    expect(readFileSync(f.statePath, 'utf8')).toBe(before);
  });
});
