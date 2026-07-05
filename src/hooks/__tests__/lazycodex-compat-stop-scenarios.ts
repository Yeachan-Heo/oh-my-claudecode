import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'vitest';
import { processLazyCodexCompatHook } from '../lazycodex-compat/index.js';
import { expectDecision } from './lazycodex-compat-assertions.js';
import {
  makeTempProject,
  writeBoulderState,
} from './lazycodex-compat-test-helpers.js';

export async function stopContinuesCurrentSession(): Promise<void> {
  const root = makeTempProject();
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n\n## TODOs\n- [x] done\n- [ ] continue me\n');
  writeBoulderState(root, { planPath, sessionIds: ['codex:sess-stop'] });

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'sess-stop',
    stop_reason: 'end-turn',
  });

  expect(result.continue).toBe(true);
  expect(result.lazycodexCompat.normalized).toMatchObject({
    eventName: 'Stop',
    portableEventId: 'session-stopping',
    cwd: root,
    sessionId: 'sess-stop',
  });
  expectDecision(result, 'start-work-continuation', 'continue');
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({ remainingCount: 1 }),
  );
  expect(result.message).toContain('fixture');
  expect(result.message).toContain('1 unfinished');
}

export async function stopContinuesCurrentSessionWithRelativePlan(): Promise<void> {
  const root = makeTempProject();
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n- [ ] current session work\n');
  writeBoulderState(root, {
    planPath,
    activePlan: '.lazycodex/plans/fixture.md',
    sessionIds: ['codex:sess-stop'],
  });

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'sess-stop',
  });

  expectDecision(result, 'start-work-continuation', 'continue');
  expect(result.message).toContain('1 unfinished');
}

export async function stopSkipsMissingSessionIds(): Promise<void> {
  const root = makeTempProject();
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n- [ ] unowned work\n');
  writeBoulderState(root, { planPath });

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'sess-stop',
  });

  expectDecision(result, 'start-work-continuation', 'idle');
  expect(result.message).toBeUndefined();
}

export async function stopSkipsForeignSession(): Promise<void> {
  const root = makeTempProject();
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n- [ ] foreign work\n');
  writeBoulderState(root, {
    planPath,
    sessionIds: ['codex:other-session'],
  });

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'sess-stop',
  });

  expectDecision(result, 'start-work-continuation', 'idle');
  expect(result.message).toBeUndefined();
}

export async function stopSkipsNonCodexPrefixedOwnership(): Promise<void> {
  const root = makeTempProject();
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n- [ ] foreign prefixed work\n');
  writeBoulderState(root, {
    planPath,
    sessionIds: ['opencode:sess'],
  });

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'opencode:sess',
  });

  expectDecision(result, 'start-work-continuation', 'idle');
  expect(result.message).toBeUndefined();
}

export async function stopSkipsBareLegacyOwnership(): Promise<void> {
  const root = makeTempProject();
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n- [ ] bare legacy work\n');
  writeBoulderState(root, {
    planPath,
    sessionIds: ['sess'],
  });

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'sess',
  });

  expectDecision(result, 'start-work-continuation', 'idle');
  expect(result.message).toBeUndefined();
}

export async function stopHandlesCorruptBoulder(): Promise<void> {
  const root = makeTempProject();
  mkdirSync(join(root, '.lazycodex'), { recursive: true });
  writeFileSync(join(root, '.lazycodex', 'boulder.json'), '{not-json');

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'sess-corrupt',
  });

  expectDecision(result, 'start-work-continuation', 'needs-evidence');
  expect(result.message).toContain('boulder.json');
}

export async function stopHandlesMissingActivePlan(): Promise<void> {
  const root = makeTempProject();
  writeBoulderState(root, {
    planPath: join(root, '.lazycodex', 'plans', 'missing.md'),
    sessionIds: ['codex:sess-missing-plan'],
  });

  const result = await processLazyCodexCompatHook({
    hook_event_name: 'Stop',
    cwd: root,
    session_id: 'sess-missing-plan',
  });

  expectDecision(result, 'start-work-continuation', 'needs-evidence');
  expect(result.message).toContain('active plan');
}
