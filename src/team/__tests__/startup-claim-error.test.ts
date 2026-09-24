import { describe, expect, it } from 'vitest';
import { claimErrorLineFromPane } from '../runtime-v2.js';

const claimLine = JSON.stringify({
  schema_version: '1.0',
  timestamp: '2026-09-06T00:00:00.000Z',
  command: 'omc team api claim-task',
  ok: true,
  operation: 'claim-task',
  data: {
    ok: false,
    error: 'claim_conflict',
    claim_token: 'secret-claim-token',
    prompt: 'private worker instructions',
  },
});

describe('claimErrorLineFromPane', () => {
  it('keeps the last claim-task failure and ignores the instruction', () => {
    const captured = [
      'team api claim-task --input "{}" --json',
      'Reading src/fixture.json',
      claimLine,
    ].join('\n');
    expect(claimErrorLineFromPane(captured)).toBe('{"ok":false,"error":"claim_conflict"}');
    expect(claimErrorLineFromPane('team api claim-task --input "{}" --json')).toBeUndefined();
    expect(claimErrorLineFromPane('')).toBeUndefined();
  });

  it('keeps a text-mode claim-task error line', () => {
    const line = 'error operation=claim-task code=invalid_input: team_name, task_id, worker are required';
    expect(claimErrorLineFromPane(`ready\n${line}\n`)).toBe('error operation=claim-task code=invalid_input');
  });

  it('rejects claim-like prompt text and unknown error codes', () => {
    expect(claimErrorLineFromPane(
      'Prompt: error operation=claim-task code=invalid_input: secret prompt text',
    )).toBeUndefined();
    expect(claimErrorLineFromPane(
      'error operation=claim-task code=private_prompt: secret prompt text',
    )).toBeUndefined();
  });

  it('keeps a pretty-printed claim failure after ok operation=claim-task', () => {
    const captured = [
      'ok operation=claim-task',
      '{',
      '  "ok": false,',
      '  "error": "claim_conflict",',
      '  "details": "brace } inside a string",',
      '  "claim_token": "secret-claim-token",',
      '  "prompt": "private worker instructions"',
      '}',
    ].join('\n');
    expect(claimErrorLineFromPane(captured)).toBe('{"ok":false,"error":"claim_conflict"}');
    expect(claimErrorLineFromPane('ok operation=claim-task\n{\n  "ok": true\n}')).toBeUndefined();
  });

  it('ignores malformed or partial pretty JSON without throwing', () => {
    const captured = 'ok operation=claim-task\n{\n  "ok": false,\n  "error": "claim_conflict"';
    expect(() => claimErrorLineFromPane(captured)).not.toThrow();
    expect(claimErrorLineFromPane(captured)).toBeUndefined();
  });

  it('bounds how much captured pane text is parsed', () => {
    const oldClaimError = [
      'ok operation=claim-task',
      '{',
      '  "ok": false,',
      '  "error": "claim_conflict"',
      '}',
    ].join('\n');
    expect(claimErrorLineFromPane(`${oldClaimError}\n${'x'.repeat(16_384)}`)).toBeUndefined();
  });

  it('does not forward long error details from a claim-task line', () => {
    const secretDetails = 'private prompt text '.repeat(30);
    const line = `error operation=claim-task code=invalid_input: ${secretDetails}`;
    const result = claimErrorLineFromPane(line);
    expect(result).toBe('error operation=claim-task code=invalid_input');
    expect(result).not.toContain(secretDetails);
    expect(result?.length).toBeLessThanOrEqual(240);
  });
});
