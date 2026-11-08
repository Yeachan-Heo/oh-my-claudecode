import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { verifyCheckEvidence, checkEvidencePath } from '../check-evidence.js';
import { planChainEnqueue, factoryStateDir } from '../chain-enqueuer.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-check-evidence-'));
  tempRoots.push(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

function evidenceDir(directory: string): string {
  return join(directory, '.omc', 'state', 'runs', 'evidence');
}

/** Write an evidence artifact; a string body is written verbatim (malformed JSON cases). */
function writeEvidence(directory: string, sessionId: string, body: unknown): void {
  mkdirSync(evidenceDir(directory), { recursive: true });
  writeFileSync(
    join(evidenceDir(directory), `${sessionId}-checks.json`),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );
}

function writeLedger(directory: string, sessionId: string, ledger: Record<string, unknown>): void {
  const dir = factoryStateDir(directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `chain-${sessionId}.json`), JSON.stringify(ledger), 'utf8');
}

function writeProjectRoutes(directory: string, table: Record<string, unknown>): void {
  const omcDir = join(directory, '.omc');
  mkdirSync(omcDir, { recursive: true });
  writeFileSync(join(omcDir, 'factory-routes.json'), JSON.stringify(table), 'utf8');
}

describe('checkEvidencePath', () => {
  it('lands under state/runs/evidence with the session id in the file name', () => {
    expect(checkEvidencePath('D:/proj/.omc', 'sess-a')).toBe(join('D:/proj/.omc', 'state', 'runs', 'evidence', 'sess-a-checks.json'));
  });
});

describe('verifyCheckEvidence', () => {
  it('returns true for a valid evidence file', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest', passed: true }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(true);
  });

  it('returns true when every recorded check passed', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest', passed: true }, { name: 'tsc', passed: true }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(true);
  });

  it('returns false when the evidence file is missing', () => {
    const dir = tempDir();
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(false);
  });

  it('returns false for malformed JSON', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', '{broken');
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(false);
  });

  it('returns false for a non-object artifact', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', [1, 2, 3]);
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(false);
  });

  it('returns false when any check failed', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest', passed: true }, { name: 'lint', passed: false }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(false);
  });

  it('returns false when a check omits the passed flag', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest' }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(false);
  });

  it('returns false when the checks field is not an array', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', { sessionId: 'sess-a', checks: 'all green', completedAt: '2026-09-30T00:00:00.000Z' });
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(false);
  });

  it('returns false when the artifact sessionId does not match', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-b',
      checks: [{ name: 'vitest', passed: true }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(verifyCheckEvidence(join(dir, '.omc'), 'sess-a')).toBe(false);
  });

  it('returns false for a traversal or malformed session id', () => {
    const dir = tempDir();
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest', passed: true }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(verifyCheckEvidence(join(dir, '.omc'), '../evil')).toBe(false);
  });
});

describe('planChainEnqueue check-evidence integration', () => {
  const GATE_FACTS = { irreversibleOrExternal: false, precedentSetting: false, valueJudgment: false, mechanicalChecksPassed: true };

  function writeAutoPassLedger(directory: string): void {
    writeLedger(directory, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'spec-approve',
      gateFacts: GATE_FACTS,
    });
    writeProjectRoutes(directory, { 'success:*': { stage: 'spec', skill: 'spec' } });
  }

  it('flag true with no evidence overrides to false and grades human', () => {
    const dir = tempDir();
    writeAutoPassLedger(dir);
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
  });

  it('flag false with evidence present still grades human (evidence never creates a pass)', () => {
    const dir = tempDir();
    writeLedger(dir, 'sess-a', {
      intentId: 'intent-a',
      routeTable: { 'success:*': { stage: 'spec', skill: 'spec' } },
      gate: 'spec-approve',
      gateFacts: { ...GATE_FACTS, mechanicalChecksPassed: false },
    });
    writeProjectRoutes(dir, { 'success:*': { stage: 'spec', skill: 'spec' } });
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest', passed: true }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
  });

  it('flag true with failing evidence grades human instead of auto-passing', () => {
    const dir = tempDir();
    writeAutoPassLedger(dir);
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest', passed: false }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toBeNull();
  });

  it('flag true with valid evidence keeps the auto-pass route', () => {
    const dir = tempDir();
    writeAutoPassLedger(dir);
    writeEvidence(dir, 'sess-a', {
      sessionId: 'sess-a',
      checks: [{ name: 'vitest', passed: true }],
      completedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(planChainEnqueue(dir, 'sess-a', 'prompt_input_exit')).toMatchObject({ sessionId: 'sess-a', intentId: 'intent-a' });
  });
});
