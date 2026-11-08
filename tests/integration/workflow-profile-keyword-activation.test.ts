import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { provisionStandaloneStateLockBridge } from '../../src/installer/index.js';

const root = process.cwd();
const installedHooks = mkdtempSync(join(tmpdir(), 'omc-keyword-installed-hooks-'));
cpSync(join(root, 'templates', 'hooks'), installedHooks, { recursive: true });
provisionStandaloneStateLockBridge(root, join(installedHooks, 'lib', 'state-lock.mjs'));
afterAll(() => rmSync(installedHooks, { recursive: true, force: true }));
const hooks = [
  join(root, 'scripts', 'keyword-detector.mjs'),
  join(installedHooks, 'keyword-detector.mjs'),
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

describe.each(hooks)('keyword detector pasted-content filtering (%s)', hook => {
  it('ignores anti-slop keywords inside pasted content with attributes on the closing tag', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'keyword-pasted-content-'));
    created.push(directory);

    const output = await invoke(
      hook,
      directory,
      '<pasted_content id="ab12">\narticle text mentioning anti-slop and AI-slop\n</pasted_content id="ab12">\n\nsummarize the material',
    );

    expect(JSON.parse(output)).toMatchObject({ continue: true, suppressOutput: true });
  });

  it('still activates anti-slop for an explicit cleanup request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'keyword-direct-cleanup-'));
    created.push(directory);

    const output = await invoke(hook, directory, 'deslop the file src/app.py please');

    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
      '[MAGIC KEYWORD: AI-SLOP-CLEANER]',
    );
  });

  it('preserves an explicit cleanup request after a malformed closing-tag newline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'keyword-malformed-newline-'));
    created.push(directory);

    const output = await invoke(
      hook,
      directory,
      '<pasted_content>reference</pasted_content\ndeslop this repo > report.txt',
    );

    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
      '[MAGIC KEYWORD: AI-SLOP-CLEANER]',
    );
  });

  it('bounds scanning across repeated malformed closing tags', { timeout: 5000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'keyword-malformed-paste-'));
    created.push(directory);
    const prompt = `<pasted_content>article mentions anti-slop</pasted_content ${'</pasted_content '.repeat(64_000)}`;

    const output = await invoke(hook, directory, prompt);

    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
      '[MAGIC KEYWORD: AI-SLOP-CLEANER]',
    );
  });
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
