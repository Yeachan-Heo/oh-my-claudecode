import { describe, it, expect } from 'vitest';
import { redactTokens } from '../redact.js';

describe('redactTokens', () => {
  // ── Slack tokens ──────────────────────────────────────────────────────

  it('redacts Slack bot tokens (xoxb-)', () => {
    const input = 'token is xoxb-123456789012-abcDEF here';
    const result = redactTokens(input);
    expect(result).not.toContain('123456789012-abcDEF');
    expect(result).toContain('xoxb-****');
  });

  it('redacts xoxb- tokens behind Bearer prefix', () => {
    const input = 'Authorization: Bearer xoxb-123456789012-abcDEF';
    const result = redactTokens(input);
    expect(result).not.toContain('123456789012-abcDEF');
    expect(result).toContain('Bearer ****');
  });

  it('redacts Slack app tokens (xapp-)', () => {
    const input = 'Token: xapp-1-A0B1C2D3E4F5-1234567890-abcdef0123456789';
    const result = redactTokens(input);
    expect(result).not.toContain('A0B1C2D3E4F5');
    expect(result).toContain('xapp-****');
  });

  it('redacts Slack user tokens (xoxp-)', () => {
    const input = 'xoxp-fake-test-value';
    const result = redactTokens(input);
    expect(result).not.toContain('fake-test-value');
    expect(result).toContain('xoxp-****');
  });

  it('redacts xoxa- tokens', () => {
    const input = 'token=xoxa-2-abc123def456';
    const result = redactTokens(input);
    expect(result).not.toContain('abc123def456');
    expect(result).toContain('xoxa-****');
  });

  // ── Telegram tokens ───────────────────────────────────────────────────

  it('redacts Telegram bot tokens in URL paths', () => {
    const input = 'GET /bot1234567890:AAHfoo-bar_BazQux123456789/getUpdates';
    const result = redactTokens(input);
    expect(result).not.toContain('AAHfoo-bar_BazQux123456789');
    expect(result).toContain('/bot1234567890:****');
    expect(result).toContain('/getUpdates');
  });

  it('redacts standalone Telegram bot tokens', () => {
    const input = 'Token is 1234567890:AAHdKq3lx_abcdefghij12345678901';
    const result = redactTokens(input);
    expect(result).not.toContain('AAHdKq3lx_abcdefghij12345678901');
    expect(result).toContain('1234567890:****');
  });

  // ── Bearer / Bot auth values ──────────────────────────────────────────

  it('redacts Bearer token values', () => {
    const input = 'Error: request failed with Bearer xoxb-secret-token-value';
    const result = redactTokens(input);
    expect(result).not.toContain('secret-token-value');
    expect(result).toContain('Bearer ****');
  });

  it('redacts Bot token values', () => {
    const input = 'Authorization: Bot MTIzNDU2Nzg5MDEy.abc.xyz123';
    const result = redactTokens(input);
    expect(result).not.toContain('MTIzNDU2Nzg5MDEy');
    expect(result).toContain('Bot ****');
  });

  it('is case-insensitive for Bearer/Bot', () => {
    const input = 'BEARER some-secret and bearer another-secret';
    const result = redactTokens(input);
    expect(result).not.toContain('some-secret');
    expect(result).not.toContain('another-secret');
  });

  // ── Safe strings (no false positives) ─────────────────────────────────

  it('does not modify strings without tokens', () => {
    const input = 'Slack Socket Mode connected';
    expect(redactTokens(input)).toBe(input);
  });

  it('does not modify normal error messages', () => {
    const input = 'HTTP 401 Unauthorized';
    expect(redactTokens(input)).toBe(input);
  });

  it('does not modify short numeric sequences', () => {
    const input = 'PID 12345 started';
    expect(redactTokens(input)).toBe(input);
  });

  it('preserves non-token parts of the message', () => {
    const input = 'Slack Socket Mode connection error: fetch failed for Bearer xoxb-secret-123';
    const result = redactTokens(input);
    expect(result).toContain('Slack Socket Mode connection error:');
    expect(result).toContain('fetch failed for');
    expect(result).not.toContain('secret-123');
  });

  // ── Multiple tokens in one string ─────────────────────────────────────

  it('redacts multiple different tokens in one string', () => {
    const input = 'appToken=xapp-1-AAA-BBB botToken=xoxb-123-secret channelId=C12345';
    const result = redactTokens(input);
    expect(result).not.toContain('AAA-BBB');
    expect(result).not.toContain('123-secret');
    expect(result).toContain('xapp-****');
    expect(result).toContain('xoxb-****');
    expect(result).toContain('channelId=C12345');
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles empty string', () => {
    expect(redactTokens('')).toBe('');
  });

  it('handles string with only whitespace', () => {
    expect(redactTokens('   ')).toBe('   ');
  });

  it('redacts tokens in error stack-like strings', () => {
    const input = 'Error: apps.connections.open failed\n  at fetch (Bearer xoxb-my-secret-token)';
    const result = redactTokens(input);
    expect(result).not.toContain('my-secret-token');
  });
});
