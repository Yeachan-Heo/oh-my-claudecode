import { describe, expect, it } from 'vitest';
import { claimErrorLineFromPane } from '../runtime-v2.js';

const claimLine = JSON.stringify({
  schema_version: '1.0',
  timestamp: '2026-09-06T00:00:00.000Z',
  command: 'omc team api claim-task',
  ok: true,
  operation: 'claim-task',
  data: { ok: false, error: 'claim_conflict' },
});

describe('claimErrorLineFromPane', () => {
  it('keeps the last claim-task failure and ignores the instruction', () => {
    const captured = [
      'team api claim-task --input "{}" --json',
      'Reading src/fixture.json',
      claimLine,
    ].join('\n');
    expect(claimErrorLineFromPane(captured)).toBe(claimLine);
    expect(claimErrorLineFromPane('team api claim-task --input "{}" --json')).toBeUndefined();
    expect(claimErrorLineFromPane('')).toBeUndefined();
  });

  it('keeps a text-mode claim-task error line', () => {
    const line = 'error operation=claim-task code=invalid_input: team_name, task_id, worker are required';
    expect(claimErrorLineFromPane(`ready\n${line}\n`)).toBe(line);
  });

  it('keeps a pretty-printed claim failure after ok operation=claim-task', () => {
    const captured = [
      'ok operation=claim-task',
      '{',
      '  "ok": false,',
      '  "error": "claim_conflict"',
      '}',
    ].join('\n');
    expect(claimErrorLineFromPane(captured)).toBe('{"ok":false,"error":"claim_conflict"}');
    expect(claimErrorLineFromPane('ok operation=claim-task\n{\n  "ok": true\n}')).toBeUndefined();
  });

  it('bounds a long claim-task failure line', () => {
    const line = `{"ok":false,"command":"omc team api claim-task","error":{"message":"${'x'.repeat(300)}"}}`;
    expect(claimErrorLineFromPane(line)).toHaveLength(240);
  });
});
