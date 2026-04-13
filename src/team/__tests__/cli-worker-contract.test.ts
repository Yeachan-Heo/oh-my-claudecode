import { describe, it, expect } from 'vitest';
import {
  CONTRACT_ROLES,
  cliWorkerOutputFilePath,
  parseCliWorkerVerdict,
  renderCliWorkerOutputContract,
  shouldInjectContract,
} from '../cli-worker-contract.js';

describe('cli-worker-contract', () => {
  describe('shouldInjectContract', () => {
    it('returns true for reviewer roles on codex', () => {
      expect(shouldInjectContract('critic', 'codex')).toBe(true);
      expect(shouldInjectContract('code-reviewer', 'codex')).toBe(true);
      expect(shouldInjectContract('security-reviewer', 'codex')).toBe(true);
      expect(shouldInjectContract('test-engineer', 'codex')).toBe(true);
    });

    it('returns true for reviewer roles on gemini', () => {
      expect(shouldInjectContract('critic', 'gemini')).toBe(true);
      expect(shouldInjectContract('code-reviewer', 'gemini')).toBe(true);
    });

    it('returns false for claude workers regardless of role', () => {
      expect(shouldInjectContract('critic', 'claude')).toBe(false);
      expect(shouldInjectContract('code-reviewer', 'claude')).toBe(false);
    });

    it('returns false for non-reviewer roles', () => {
      expect(shouldInjectContract('executor', 'codex')).toBe(false);
      expect(shouldInjectContract('architect', 'gemini')).toBe(false);
      expect(shouldInjectContract('planner', 'codex')).toBe(false);
    });

    it('returns false for null/undefined inputs', () => {
      expect(shouldInjectContract(null, 'codex')).toBe(false);
      expect(shouldInjectContract('critic', null)).toBe(false);
      expect(shouldInjectContract(undefined, undefined)).toBe(false);
    });
  });

  describe('CONTRACT_ROLES', () => {
    it('contains exactly the four reviewer-style roles', () => {
      expect(new Set(CONTRACT_ROLES)).toEqual(
        new Set(['critic', 'code-reviewer', 'security-reviewer', 'test-engineer']),
      );
    });
  });

  describe('renderCliWorkerOutputContract', () => {
    it('embeds the role and file path in the rendered prompt', () => {
      const fragment = renderCliWorkerOutputContract(
        'code-reviewer',
        '/tmp/team/workers/worker-1/verdict.json',
      );
      expect(fragment).toContain('code-reviewer');
      expect(fragment).toContain('/tmp/team/workers/worker-1/verdict.json');
      expect(fragment).toContain('"verdict": "approve" | "revise" | "reject"');
      expect(fragment).toContain('REQUIRED: Structured Verdict Output');
    });

    it('documents the severity enum', () => {
      const fragment = renderCliWorkerOutputContract('critic', '/x/verdict.json');
      expect(fragment).toContain('"critical" | "major" | "minor" | "nit"');
    });
  });

  describe('cliWorkerOutputFilePath', () => {
    it('joins team state root + worker into the conventional path', () => {
      const p = cliWorkerOutputFilePath('/repo/.omc/state/team/foo', 'worker-2');
      expect(p).toBe('/repo/.omc/state/team/foo/workers/worker-2/verdict.json');
    });

    it('normalizes windows backslashes to forward slashes', () => {
      const p = cliWorkerOutputFilePath('C:\\proj\\.omc\\state\\team\\foo', 'worker-1');
      expect(p).toBe('C:/proj/.omc/state/team/foo/workers/worker-1/verdict.json');
    });
  });

  describe('parseCliWorkerVerdict', () => {
    it('parses a valid approve verdict with empty findings', () => {
      const raw = JSON.stringify({
        role: 'code-reviewer',
        task_id: '4',
        verdict: 'approve',
        summary: 'Looks good.',
        findings: [],
      });
      const parsed = parseCliWorkerVerdict(raw);
      expect(parsed.role).toBe('code-reviewer');
      expect(parsed.task_id).toBe('4');
      expect(parsed.verdict).toBe('approve');
      expect(parsed.summary).toBe('Looks good.');
      expect(parsed.findings).toEqual([]);
    });

    it('parses a revise verdict with findings', () => {
      const raw = JSON.stringify({
        role: 'critic',
        task_id: '7',
        verdict: 'revise',
        summary: 'Needs work.',
        findings: [
          { severity: 'major', message: 'Fix X', file: 'src/x.ts', line: 42 },
          { severity: 'nit', message: 'Typo Y' },
        ],
      });
      const parsed = parseCliWorkerVerdict(raw);
      expect(parsed.verdict).toBe('revise');
      expect(parsed.findings).toHaveLength(2);
      expect(parsed.findings[0]).toEqual({
        severity: 'major',
        message: 'Fix X',
        file: 'src/x.ts',
        line: 42,
      });
      expect(parsed.findings[1]).toEqual({ severity: 'nit', message: 'Typo Y' });
    });

    it('rejects invalid JSON', () => {
      expect(() => parseCliWorkerVerdict('not json')).toThrow(/verdict_json_parse_failed/);
    });

    it('rejects missing fields', () => {
      expect(() => parseCliWorkerVerdict('{}')).toThrow(/verdict_missing_role/);
      expect(() => parseCliWorkerVerdict(JSON.stringify({ role: 'critic' })))
        .toThrow(/verdict_missing_task_id/);
    });

    it('rejects unknown verdict value', () => {
      const raw = JSON.stringify({
        role: 'critic', task_id: '1', verdict: 'maybe', summary: 's', findings: [],
      });
      expect(() => parseCliWorkerVerdict(raw)).toThrow(/verdict_invalid_verdict/);
    });

    it('rejects unknown severity value', () => {
      const raw = JSON.stringify({
        role: 'critic',
        task_id: '1',
        verdict: 'revise',
        summary: 's',
        findings: [{ severity: 'blocker', message: 'x' }],
      });
      expect(() => parseCliWorkerVerdict(raw)).toThrow(/verdict_finding_0_invalid_severity/);
    });

    it('rejects findings-not-array', () => {
      const raw = JSON.stringify({
        role: 'critic', task_id: '1', verdict: 'approve', summary: 's', findings: {},
      });
      expect(() => parseCliWorkerVerdict(raw)).toThrow(/verdict_findings_not_array/);
    });
  });
});
