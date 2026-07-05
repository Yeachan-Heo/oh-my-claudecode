import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'vitest';
import { processLazyCodexCompatHook } from '../lazycodex-compat/index.js';
import {
  expectUltraworkContract,
  runLazyCodexCompatCli,
} from './lazycodex-compat-assertions.js';
import {
  makeTempProject,
  readJson,
  runPackedLazyCodexCompatHookFixture,
  runRegisteredLazyCodexCompatFixtures,
  writeBoulderState,
  writeProjectRule,
} from './lazycodex-compat-test-helpers.js';

export async function userPromptActivatesUltrawork(): Promise<void> {
  const root = makeTempProject();
  writeProjectRule(root);
  const injectedPath = join(root, 'prompt-injection-ran');

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'UserPromptSubmit',
    cwd: root,
    session_id: 'sess-user',
    prompt: `ulw continue this carefully; touch ${injectedPath}`,
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.normalized).toMatchObject({
    eventName: 'UserPromptSubmit',
    portableEventId: 'prompt-submitted',
    cwd: root,
    sessionId: 'sess-user',
  });
  expect(result.lazycodexCompat.decisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ behavior: 'project-rules', decision: 'loaded', artifactCount: 1 }),
    expect.objectContaining({ behavior: 'ultrawork-trigger', decision: 'activate' }),
    expect.objectContaining({ behavior: 'host-policy', decision: 'disabled-by-default' }),
  ]));
  expectUltraworkContract(result.message);
  expect(existsSync(injectedPath)).toBe(false);
  expect(readJson(join(root, '.lazycodex', 'ulw-loop', 'steering.json'))).toMatchObject({
    schema_version: 1,
    session_id: 'sess-user',
    active: true,
    trigger: 'ultrawork',
  });
}

export async function userPromptRejectsSymlinkedSteeringSink(): Promise<void> {
  const root = makeTempProject();
  const targetPath = join(root, 'steering-target.txt');
  const steeringPath = join(root, '.lazycodex', 'ulw-loop', 'steering.json');
  mkdirSync(join(root, '.lazycodex', 'ulw-loop'), { recursive: true });
  writeFileSync(targetPath, 'unchanged\n');
  symlinkSync(targetPath, steeringPath);

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'UserPromptSubmit',
    cwd: root,
    session_id: 'sess-user',
    prompt: 'ulw continue this carefully',
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({
      behavior: 'ulw-steering',
      decision: 'refused',
    }),
  );
  expect(readFileSync(targetPath, 'utf8')).toBe('unchanged\n');
}

export async function postToolCommentsAreData(): Promise<void> {
  const root = makeTempProject();
  const injectedPath = join(root, 'comment-injection-ran');

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'PostToolUse',
    cwd: root,
    session_id: 'sess-post',
    tool_name: 'Write',
    tool_input: {
      file_path: join(root, 'src', 'adapter.ts'),
      content: `const value = 1;\n// remove me; touch ${injectedPath}\n`,
    },
    tool_response: 'wrote file successfully',
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.normalized).toMatchObject({
    eventName: 'PostToolUse',
    portableEventId: 'tool-use-after',
    cwd: root,
    sessionId: 'sess-post',
    toolName: 'Write',
  });
  expect(result.lazycodexCompat.decisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ behavior: 'comment-checking', decision: 'needs-action' }),
    expect.objectContaining({ behavior: 'lsp-codegraph-guidance', decision: 'advise' }),
  ]));
  expect(result.message).toContain('COMMENT/DOCSTRING DETECTED');
  expect(result.message).toContain('LSP diagnostics');
  expect(existsSync(injectedPath)).toBe(false);
}

export async function preCompactRecordsReset(): Promise<void> {
  const root = makeTempProject();
  const result = await processLazyCodexCompatHook({
    hook_event_name: 'PreCompact',
    cwd: root,
    session_id: 'sess-compact',
    trigger: 'manual',
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.normalized).toMatchObject({
    eventName: 'PreCompact',
    portableEventId: 'compact-before',
    cwd: root,
    sessionId: 'sess-compact',
  });
  expect(result.lazycodexCompat.sideEffects).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'reset-project-rule-cache' }),
    expect.objectContaining({ name: 'reset-lsp-diagnostics-cache' }),
  ]));
  expect(readJson(join(root, '.lazycodex', 'hook-cache-resets.json'))).toMatchObject({
    schema_version: 1,
    session_id: 'sess-compact',
    event: 'compact-before',
  });
}

export async function preCompactRejectsSymlinkedCacheResetSink(): Promise<void> {
  const root = makeTempProject();
  const targetPath = join(root, 'cache-reset-target.txt');
  const resetPath = join(root, '.lazycodex', 'hook-cache-resets.json');
  mkdirSync(join(root, '.lazycodex'), { recursive: true });
  writeFileSync(targetPath, 'unchanged\n');
  symlinkSync(targetPath, resetPath);

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'PreCompact',
    cwd: root,
    session_id: 'sess-compact',
    trigger: 'manual',
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({
      behavior: 'cache-reset',
      decision: 'refused',
    }),
  );
  expect(readFileSync(targetPath, 'utf8')).toBe('unchanged\n');
}

export async function subagentVerifiesExecutorEvidence(): Promise<void> {
  const root = makeTempProject();
  const evidencePath = join(root, '.lazycodex', 'evidence', 'worker.md');
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n- [ ] executor evidence fixture\n');
  writeBoulderState(root, { planPath, sessionIds: ['codex:sess-subagent'] });
  mkdirSync(join(root, '.lazycodex', 'evidence'), { recursive: true });
  writeFileSync(evidencePath, 'worker evidence\n');

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'SubagentStop',
    cwd: root,
    session_id: 'sess-subagent',
    agent_id: 'agent-1',
    agent_type: 'lazycodex-executor',
    success: true,
    output: JSON.stringify({ DoneClaim: { task: 'fixture', manual_qa: [evidencePath], tests: ['node fixture exited 0'] } }),
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.normalized).toMatchObject({
    eventName: 'SubagentStop',
    portableEventId: 'subagent-stopped',
    cwd: root,
    sessionId: 'sess-subagent',
    agentId: 'agent-1',
    agentType: 'lazycodex-executor',
  });
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({ behavior: 'executor-evidence', decision: 'verified', artifactCount: 1 }),
  );
  expect(readFileSync(join(root, '.lazycodex', 'evidence', 'executor-verification.jsonl'), 'utf8')).toContain(evidencePath);
}

export async function subagentRejectsSymlinkedExecutorLedgerSink(): Promise<void> {
  const root = makeTempProject();
  const evidencePath = join(root, '.lazycodex', 'evidence', 'worker.md');
  const ledgerPath = join(root, '.lazycodex', 'evidence', 'executor-verification.jsonl');
  const targetPath = join(root, 'executor-ledger-target.txt');
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  mkdirSync(join(root, '.lazycodex', 'evidence'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n- [ ] executor evidence fixture\n');
  writeBoulderState(root, { planPath, sessionIds: ['codex:sess-subagent'] });
  writeFileSync(evidencePath, 'worker evidence\n');
  writeFileSync(targetPath, 'unchanged\n');
  symlinkSync(targetPath, ledgerPath);

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'SubagentStop',
    cwd: root,
    session_id: 'sess-subagent',
    agent_id: 'agent-1',
    agent_type: 'lazycodex-executor',
    success: true,
    output: JSON.stringify({ DoneClaim: { task: 'fixture', manual_qa: [evidencePath], tests: ['node fixture exited 0'] } }),
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({
      behavior: 'executor-evidence',
      decision: 'needs-evidence',
    }),
  );
  expect(result.message).toContain('unsafe .lazycodex sink');
  expect(readFileSync(targetPath, 'utf8')).toBe('unchanged\n');
}

export async function malformedHookFieldsNeedEvidence(): Promise<void> {
  const result = await processLazyCodexCompatHook({
    hook_event_name: 'SubagentStop',
    output: JSON.stringify({ DoneClaim: { task: 'fixture', manual_qa: ['/tmp/missing-evidence.md'], tests: ['echo misleading pass'] } }),
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.normalized.eventName).toBe('SubagentStop');
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({ behavior: 'executor-evidence', decision: 'needs-evidence' }),
  );
  expect(result.message).toContain('evidence');
}

export function malformedCliInputIsStructured(): void {
  const output = runLazyCodexCompatCli('UserPromptSubmit', '{bad-json');
  expect(output).toMatchObject({
    continue: true,
    lazycodexCompat: {
      normalized: { eventName: 'UserPromptSubmit' },
      decisions: [expect.objectContaining({ behavior: 'malformed-input', decision: 'needs-evidence' })],
    },
  });
}

export function registryCommandsAreRunnable(): void {
  for (const { command, eventName, output } of runRegisteredLazyCodexCompatFixtures(process.cwd())) {
    expect(command).not.toContain('dist/hooks/lazycodex-compat/cli.js');
    expect(output).toMatchObject({
      continue: true,
      lazycodexCompat: { normalized: { eventName } },
    });
  }
}

export function packagedWrapperUsesCompiledAdapter(): void {
  const { output, projectRoot } = runPackedLazyCodexCompatHookFixture();

  expect(output).toMatchObject({
    continue: true,
    lazycodexCompat: {
      normalized: {
        eventName: 'UserPromptSubmit',
        portableEventId: 'prompt-submitted',
        cwd: projectRoot,
        sessionId: 'packed-session',
      },
      decisions: [
        expect.objectContaining({ behavior: 'project-rules' }),
        expect.objectContaining({ behavior: 'host-policy' }),
        expect.objectContaining({ behavior: 'ultrawork-trigger', decision: 'idle' }),
      ],
    },
  });
  expect(JSON.stringify(output)).not.toContain('source-owned LazyCodex compatibility CLI is missing');
}
