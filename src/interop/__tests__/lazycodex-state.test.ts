import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLazyCodexStatePaths,
  readLazyCodexJsonState,
  validateLazyCodexExecutionState,
  writeLazyCodexJsonState,
} from '../lazycodex-state.js';

const tempRoots: string[] = [];

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omc-lazycodex-state-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  return root;
}

function writeActivePlan(root: string): string {
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n\n## TODOs\n- [ ] T7 fixture\n');
  return planPath;
}

function makeBoulderState(planPath: string, updatedAt = new Date().toISOString()): Record<string, unknown> {
  return {
    schema_version: 2,
    active_work_id: 'work-1',
    works: {
      'work-1': {
        active_plan: planPath,
        plan_name: 'fixture',
        session_ids: ['codex:sess-state'],
        status: 'active',
        updated_at: updatedAt,
      },
    },
  };
}

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('LazyCodex state compatibility', () => {
  it('keeps Boulder, ULW, start-work, executor evidence, and ledger paths under canonical .lazycodex', async () => {
    // given
    const root = await makeTempProject();

    // when
    const paths = getLazyCodexStatePaths(root);

    // then
    expect(paths.boulder).toBe(join(root, '.lazycodex', 'boulder.json'));
    expect(paths.ulwSteering).toBe(join(root, '.lazycodex', 'ulw-loop', 'steering.json'));
    expect(paths.ulwLedger).toBe(join(root, '.lazycodex', 'ulw-loop', 'ledger.jsonl'));
    expect(paths.startWorkLedger).toBe(join(root, '.lazycodex', 'start-work', 'ledger.jsonl'));
    expect(paths.executorEvidenceLedger).toBe(join(root, '.lazycodex', 'evidence', 'executor-verification.jsonl'));
    expect(Object.values(paths).some((path) => path.includes(`${join(root, '.omc')}`))).toBe(false);
  });

  it('writes and reads canonical .lazycodex JSON without creating .omc', async () => {
    // given
    const root = await makeTempProject();
    const planPath = writeActivePlan(root);
    const state = makeBoulderState(planPath);

    // when
    writeLazyCodexJsonState(root, 'boulder', state);
    const result = readLazyCodexJsonState(root, 'boulder');

    // then
    expect(result).toEqual({
      source: 'lazycodex',
      path: join(root, '.lazycodex', 'boulder.json'),
      data: state,
    });
    expect(JSON.parse(readFileSync(join(root, '.lazycodex', 'boulder.json'), 'utf8'))).toEqual(state);
    expect(existsSync(join(root, '.omc'))).toBe(false);
  });

  it('reads .omc bridge state only when explicit bridge compatibility is requested', async () => {
    // given
    const root = await makeTempProject();
    const planPath = writeActivePlan(root);
    const bridgedState = makeBoulderState(planPath);
    const bridgePath = join(root, '.omc', 'state', 'interop', 'lazycodex', 'boulder.json');
    mkdirSync(join(root, '.omc', 'state', 'interop', 'lazycodex'), { recursive: true });
    writeFileSync(bridgePath, `${JSON.stringify(bridgedState)}\n`);

    // when
    const defaultRead = readLazyCodexJsonState(root, 'boulder');
    const bridgeRead = readLazyCodexJsonState(root, 'boulder', { allowBridgeRead: true });

    // then
    expect(defaultRead).toBeNull();
    expect(bridgeRead).toEqual({
      source: 'omc-bridge',
      path: bridgePath,
      data: bridgedState,
    });
  });

  it('prefers canonical .lazycodex state over explicit .omc bridge state', async () => {
    // given
    const root = await makeTempProject();
    const planPath = writeActivePlan(root);
    const canonicalState = makeBoulderState(planPath);
    const bridgedState = makeBoulderState(planPath, '2026-01-01T00:00:00.000Z');
    mkdirSync(join(root, '.omc', 'state', 'interop', 'lazycodex'), { recursive: true });
    writeFileSync(join(root, '.omc', 'state', 'interop', 'lazycodex', 'boulder.json'), `${JSON.stringify(bridgedState)}\n`);

    // when
    writeLazyCodexJsonState(root, 'boulder', canonicalState);
    const result = readLazyCodexJsonState(root, 'boulder', { allowBridgeRead: true });

    // then
    expect(result?.source).toBe('lazycodex');
    expect(result?.data).toEqual(canonicalState);
  });

  it('accepts active non-stale Boulder state for the current Claude session through codex-prefixed ownership', async () => {
    // given
    const root = await makeTempProject();
    const planPath = writeActivePlan(root);
    writeLazyCodexJsonState(root, 'boulder', makeBoulderState(planPath));

    // when
    const result = validateLazyCodexExecutionState(root, 'sess-state');

    // then
    expect(result.ok).toBe(true);
    expect(result.ok ? result.work.planName : '').toBe('fixture');
  });

  it('rejects stale, missing, and foreign Boulder execution state as data', async () => {
    // given
    const root = await makeTempProject();
    const planPath = writeActivePlan(root);

    // when / then
    expect(validateLazyCodexExecutionState(root, 'sess-state')).toEqual({
      ok: false,
      reason: 'missing .lazycodex/boulder.json',
    });

    writeLazyCodexJsonState(root, 'boulder', makeBoulderState(planPath, '2000-01-01T00:00:00.000Z'));
    expect(validateLazyCodexExecutionState(root, 'sess-state')).toEqual({
      ok: false,
      reason: 'stale .lazycodex/boulder.json active work',
    });

    writeLazyCodexJsonState(root, 'boulder', makeBoulderState(planPath));
    expect(validateLazyCodexExecutionState(root, 'other-session')).toEqual({
      ok: false,
      reason: 'no active Boulder work for current session',
    });
  });

  it('rejects malformed and unreadable Boulder execution state as data', async () => {
    // given
    const root = await makeTempProject();
    mkdirSync(join(root, '.lazycodex'), { recursive: true });

    // when / then
    writeFileSync(join(root, '.lazycodex', 'boulder.json'), '{bad json\n');
    expect(validateLazyCodexExecutionState(root, 'sess-state')).toEqual({
      ok: false,
      reason: 'malformed .lazycodex/boulder.json',
    });

    rmSync(join(root, '.lazycodex', 'boulder.json'), { force: true });
    mkdirSync(join(root, '.lazycodex', 'boulder.json'));
    const unreadableState = validateLazyCodexExecutionState(root, 'sess-state');
    expect(unreadableState.ok).toBe(false);
    expect(unreadableState.ok ? '' : unreadableState.reason).toContain('unreadable .lazycodex/boulder.json');
  });
});
