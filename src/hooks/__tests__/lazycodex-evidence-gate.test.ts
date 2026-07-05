import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processLazyCodexCompatHook } from '../lazycodex-compat/index.js';

const tempRoots: string[] = [];

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omc-lazycodex-evidence-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  return root;
}

function writeActiveLazyCodexState(root: string, sessionId = 'sess-evidence', updatedAt = new Date().toISOString()): void {
  const planPath = join(root, '.lazycodex', 'plans', 'fixture.md');
  mkdirSync(join(root, '.lazycodex', 'plans'), { recursive: true });
  writeFileSync(planPath, '# Fixture\n\n## TODOs\n- [ ] evidence gate fixture\n');
  mkdirSync(join(root, '.lazycodex'), { recursive: true });
  writeFileSync(
    join(root, '.lazycodex', 'boulder.json'),
    `${JSON.stringify({
      schema_version: 2,
      active_work_id: 'work-1',
      works: {
        'work-1': {
          active_plan: planPath,
          plan_name: 'fixture',
          session_ids: [`codex:${sessionId}`],
          status: 'active',
          updated_at: updatedAt,
        },
      },
    })}\n`,
  );
}

function writeEvidence(root: string, name: string, content: string): string {
  const path = join(root, '.lazycodex', 'evidence', name);
  mkdirSync(join(root, '.lazycodex', 'evidence'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function doneClaimWith(receipts: readonly string[]): string {
  return JSON.stringify({
    DoneClaim: {
      task: 'fixture',
      changed_files: [],
      tests: ['echo success exited 0'],
      manual_qa: receipts,
    },
  });
}

async function runSubagentEvidenceGate(root: string, output: string, sessionId = 'sess-evidence') {
  return processLazyCodexCompatHook({
    hook_event_name: 'SubagentStop',
    cwd: root,
    session_id: sessionId,
    agent_id: 'agent-1',
    agent_type: 'lazycodex-executor',
    success: true,
    output,
  });
}

function expectEvidenceDecision(result: Awaited<ReturnType<typeof runSubagentEvidenceGate>>, decision: string): void {
  expect(result.lazycodexCompat.decisions).toContainEqual(
    expect.objectContaining({ behavior: 'executor-evidence', decision }),
  );
}

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('LazyCodex executor evidence gate', () => {
  it('accepts a materially non-empty receipt inside project-owned .lazycodex/evidence when active .lazycodex state is current', async () => {
    // given
    const root = await makeTempProject();
    writeActiveLazyCodexState(root);
    const receipt = writeEvidence(root, 'valid.md', 'scenario: valid receipt\nobservable: PASS\n');

    // when
    const result = await runSubagentEvidenceGate(root, doneClaimWith([receipt]));

    // then
    expectEvidenceDecision(result, 'verified');
    expect(result.lazycodexCompat.sideEffects).toContainEqual(
      expect.objectContaining({ name: 'append-executor-evidence-ledger' }),
    );
    expect(existsSync(join(root, '.lazycodex', 'evidence', 'executor-verification.jsonl'))).toBe(true);
  });

  it('rejects missing, zero-byte, whitespace-only, traversal, out-of-root, and symlink-escape receipts', async () => {
    // given
    const root = await makeTempProject();
    writeActiveLazyCodexState(root);
    const missing = join(root, '.lazycodex', 'evidence', 'missing.md');
    const zeroByte = writeEvidence(root, 'zero.md', '');
    const whitespaceOnly = writeEvidence(root, 'whitespace.md', ' \n\t\n');
    const outsideEvidence = join(root, '.lazycodex', 'secret.md');
    writeFileSync(outsideEvidence, 'not evidence\n');
    const outOfRoot = join(tmpdir(), `omc-lazycodex-outside-${process.pid}.md`);
    writeFileSync(outOfRoot, 'outside\n');
    tempRoots.push(outOfRoot);
    const symlinkTarget = join(tmpdir(), `omc-lazycodex-target-${process.pid}.md`);
    writeFileSync(symlinkTarget, 'target\n');
    tempRoots.push(symlinkTarget);
    const symlinkPath = join(root, '.lazycodex', 'evidence', 'escape.md');
    symlinkSync(symlinkTarget, symlinkPath);

    const cases = [
      { receipt: missing, reason: 'missing artifact' },
      { receipt: zeroByte, reason: 'empty artifact' },
      { receipt: whitespaceOnly, reason: 'empty artifact' },
      { receipt: '.lazycodex/evidence/../secret.md', reason: 'artifact is outside .lazycodex/evidence' },
      { receipt: outOfRoot, reason: 'artifact is outside project root' },
      { receipt: symlinkPath, reason: 'symbolic link artifact' },
    ];

    for (const fixture of cases) {
      // when
      const result = await runSubagentEvidenceGate(root, doneClaimWith([fixture.receipt]));

      // then
      expectEvidenceDecision(result, 'needs-evidence');
      expect(result.message).toContain(fixture.reason);
    }
  });

  it('rejects valid-looking receipts when .lazycodex Boulder state is missing, stale, or not owned by the current session', async () => {
    // given
    const root = await makeTempProject();
    const receipt = writeEvidence(root, 'valid.md', 'observable: PASS\n');

    // when / then
    const missingState = await runSubagentEvidenceGate(root, doneClaimWith([receipt]));
    expectEvidenceDecision(missingState, 'needs-evidence');
    expect(missingState.message).toContain('missing .lazycodex/boulder.json');

    writeActiveLazyCodexState(root, 'sess-evidence', '2000-01-01T00:00:00.000Z');
    const staleState = await runSubagentEvidenceGate(root, doneClaimWith([receipt]));
    expectEvidenceDecision(staleState, 'needs-evidence');
    expect(staleState.message).toContain('stale .lazycodex/boulder.json active work');

    writeActiveLazyCodexState(root, 'other-session');
    const foreignState = await runSubagentEvidenceGate(root, doneClaimWith([receipt]));
    expectEvidenceDecision(foreignState, 'needs-evidence');
    expect(foreignState.message).toContain('no active Boulder work for current session');
  });

  it('rejects misleading success-only DoneClaim output without artifact-backed receipts', async () => {
    // given
    const root = await makeTempProject();
    writeActiveLazyCodexState(root);

    // when
    const result = await runSubagentEvidenceGate(
      root,
      JSON.stringify({
        DoneClaim: {
          task: 'fixture',
          tests: ['npm test exited 0'],
          manual_qa: [],
          cleanup: ['temp dir removed'],
          risks: ['none'],
        },
      }),
    );

    // then
    expectEvidenceDecision(result, 'needs-evidence');
    expect(result.message).toContain('at least one non-empty artifact path');
  });

  it('rejects valid-looking receipts with structured needs-evidence when .lazycodex Boulder state is malformed', async () => {
    // given
    const root = await makeTempProject();
    const receipt = writeEvidence(root, 'valid.md', 'observable: PASS\n');
    mkdirSync(join(root, '.lazycodex'), { recursive: true });
    writeFileSync(join(root, '.lazycodex', 'boulder.json'), '{bad json\n');

    // when
    const result = await runSubagentEvidenceGate(root, doneClaimWith([receipt]));

    // then
    expectEvidenceDecision(result, 'needs-evidence');
    expect(result.message).toContain('malformed .lazycodex/boulder.json');
  });
});
