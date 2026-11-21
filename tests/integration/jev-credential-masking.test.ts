import { describe, expect, it } from 'vitest';
import { maskListText } from '../../scripts/lib/jev-task-list.mjs';

describe('maskListText credential redaction', () => {
  it('redacts API keys in unquoted field assignments', () => {
    expect(maskListText('api_key=sk-proj-secret123abc')).toContain('***');
    expect(maskListText('api_key=sk-proj-secret123abc')).not.toContain('secret123abc');
  });

  it('redacts credentials in quoted JSON field names', () => {
    // The finding: quoted JSON field names like "api_key" were not being redacted
    // when the value appeared on the same line with : or =
    expect(maskListText('Configure {"api_key":"sk-proj-secret123abc"}')).toContain('***');
    expect(maskListText('Configure {"api_key":"sk-proj-secret123abc"}')).not.toContain('secret123abc');
  });

  it('redacts credentials with quoted JSON field names and spaces', () => {
    expect(maskListText('{ "api_key" : "sk-proj-secret123abc" }')).toContain('***');
    expect(maskListText('{ "api_key" : "sk-proj-secret123abc" }')).not.toContain('secret123abc');
  });

  it('redacts bearer tokens', () => {
    expect(maskListText('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9token')).toContain('***');
    expect(maskListText('Authorization: Bearer token123456789abcdef')).not.toContain('token123456789abcdef');
  });

  it('redacts GitHub tokens', () => {
    // Assembled at run time so that no literal token-shaped string sits in the source.
    const token = ['ghp', '1234567890abcdefghijklmnopqrstuv'].join('_');
    expect(maskListText(token)).toContain('ghp_***');
    expect(maskListText(token)).not.toContain('1234567890abc');
  });

  it('redacts PASSWORD assignments', () => {
    expect(maskListText('password=mysecretpass123')).toContain('***');
    expect(maskListText('password=mysecretpass123')).not.toContain('mysecretpass123');
  });

  it('redacts credentials with quoted values', () => {
    expect(maskListText('api_key="secret-value-here"')).toContain('***');
    expect(maskListText("api_key='secret-value-here'")).toContain('***');
  });

  it('only masks keyword:value or keyword=value patterns, not bare keywords', () => {
    // Bare keywords without assignment operators are NOT masked
    expect(maskListText('Deploy the secret sauce recipe')).not.toContain('***');
    // But password: pattern followed by text IS masked (matches the pattern)
    expect(maskListText('Password: required for entry')).toContain('***');
  });

  it('handles mixed quoted and unquoted fields', () => {
    const input = 'API {"key":"value123", password=pass456, "token": "tok789"}';
    const masked = maskListText(input);
    expect(masked).not.toContain('value123');
    expect(masked).not.toContain('pass456');
    expect(masked).not.toContain('tok789');
  });
});
