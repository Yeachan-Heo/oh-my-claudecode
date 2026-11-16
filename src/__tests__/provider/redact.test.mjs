/* global process */
// Redaction of secrets in provider messages: six
// credential shapes, JSON fields, labels kept, plain texts unchanged, provider key shapes).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mask } = require('../../../scripts/provider/lib/redact.cjs');

describe.skipIf(process.platform === 'win32')('mask (secret redaction)', () => {
  it('(17) masks the six credential shapes, JSON fields and provider keys; labels stay; plain texts are unchanged', () => {
    const bearer = mask('Authorization: Bearer abc.123_XYZ-456defgh7890');
    expect(bearer).toMatch(/\bBearer\s+\[REDACTED\]/);
    expect(bearer).not.toContain('abc.123_XYZ');

    const sk = mask('bad key sk-abc123def456ghi789');
    expect(sk).toMatch(/sk-\[REDACTED\]/);
    expect(sk).not.toContain('abc123def456ghi789');

    const ghp = mask(`ghp_${'a1'.repeat(18)}`);
    expect(ghp).toMatch(/ghp_\[REDACTED\]/);
    expect(ghp).not.toContain('a1'.repeat(18));

    const aiza = mask(`AIza${'Ab1-_'.repeat(7)}`);
    expect(aiza).toMatch(/AIza\[REDACTED\]/);
    expect(aiza).not.toContain('Ab1-_Ab1-_');

    const token = mask('https://callback.example/cb?token=fixture-1234-value&x=1');
    expect(token).toMatch(/token=\[REDACTED\]&x=1/);
    expect(token).not.toContain('fixture-1234-value');

    const accessToken = mask('access_token=long-fixture-1234567890');
    expect(accessToken).toMatch(/access_token=\[REDACTED\]/);
    expect(accessToken).not.toContain('long-fixture-1234567890');

    const blob = mask('x A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v z');
    expect(blob).toContain('[REDACTED]');
    expect(blob).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v');

    const json = mask('{"msg":"bad key","api_key":"fixture-value","token":"second-fixture-value"}');
    expect(json).toContain('"api_key":"[REDACTED]"');
    expect(json).toContain('"token":"[REDACTED]"');
    expect(json).toContain('bad key');
  });

  it('leaves fixed messages, paths and endpoints without changes', () => {
    const stale = [
      'no usable provider API key (file missing, empty, or with whitespace inside); start aborted, claude was not launched',
      'OMC_PROVIDER_BASE_URL and OMC_PROVIDER_API_KEY_FILE must be set together',
      '/home/user/.omc/state/provider/acme/worker-settings/worker-team-a-1731686400000-ab12cd34.json',
      'https://llm.acme.example/anthropic',
    ];
    for (const text of stale) {
      expect(mask(text), text).toBe(text);
    }
  });

  it('masks a provider key in every context: bare, after "key:", in JSON, after api_key=, in a URL', () => {
    const key = '6789012345abcdef6789012345abcdef.AbCdEfGhIjKlMnOp';
    const contexts = [
      ['bare', `key ${key} in the text`],
      ['after key:', `key: ${key}`],
      ['in JSON', `{"error":{"message":"bad key ${key}"}}`],
      ['after api_key=', `api_key=${key}`],
      ['in URL', `https://host.example/cb?api_key=${key}`],
    ];
    for (const [name, text] of contexts) {
      const out = mask(text);
      expect(out, name).toContain('[REDACTED]');
      expect(out, name).not.toContain('AbCdEfGhIjKlMnOp');
      expect(out, name).not.toContain('6789012345abcdef');
    }
  });

  it('is idempotent on its own output', () => {
    const once = mask('sk-abc123def456ghi789 and token=fixture-1234');
    expect(mask(once)).toBe(once);
  });
});
