/* global process, Buffer */
// Pure pieces of the local provider proxy: header filtering, retry delays, body decoding,
// classification of held answers, upstream URL rules and log redaction.
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import {
  backoffDelayMs, buildUpstreamHeaders, decodeBody, filterResponseHeaders, isPermanentFailure, parseUpstream,
  redactText, retryAfterDelayMs,
} from '../../../scripts/provider/provider-proxy.mjs';

describe.skipIf(process.platform === 'win32')('provider proxy: pure pieces', () => {
  it('request headers: credentials, cookies, forwarding and hop-by-hop headers are dropped; the key is set', () => {
    const headers = buildUpstreamHeaders({
      host: '127.0.0.1:1', connection: 'keep-alive, x-private', 'x-private': '1', 'keep-alive': 'timeout=5',
      authorization: 'Bearer client', 'x-api-key': 'client', cookie: 'a=b', 'content-length': '999',
      'transfer-encoding': 'chunked', 'x-forwarded-for': '1.1.1.1', 'x-forwarded-host': 'h', 'x-forwarded-proto': 'https',
      forwarded: 'for=1', via: '1.1 p', expect: '100-continue', 'anthropic-beta': 'x', 'content-type': 'application/json',
    }, 'api.example:443', 'KEY', 4, 'POST');
    expect(headers).toEqual({
      host: 'api.example:443', authorization: 'Bearer KEY', 'x-api-key': 'KEY', 'anthropic-beta': 'x',
      'content-type': 'application/json', 'content-length': '4',
    });
  });

  it('request headers: no x-api-key without one from the client, no content-length for an empty GET', () => {
    const headers = buildUpstreamHeaders({ host: 'h', authorization: 'Bearer c', accept: '*/*' }, 'u', 'KEY', 0, 'GET');
    expect(headers).toEqual({ host: 'u', authorization: 'Bearer KEY', accept: '*/*' });
    expect(buildUpstreamHeaders({}, 'u', 'KEY', 0, 'POST')['content-length']).toBe('0');
  });

  it('response headers: hop-by-hop headers and the ones named by Connection are dropped, repeated headers stay', () => {
    const raw = ['Content-Type', 'text/plain', 'Connection', 'close, X-Hop', 'X-Hop', '1', 'Transfer-Encoding', 'chunked',
      'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5', 'Keep-Alive', 'timeout=1', 'Upgrade', 'h2c'];
    expect(filterResponseHeaders(raw)).toEqual(['Content-Type', 'text/plain', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Content-Length', '5']);
  });

  it('backoff: exponential, capped, bounded exponent', () => {
    expect(backoffDelayMs(0, 1, 100)).toBe(1);
    expect(backoffDelayMs(3, 1, 100)).toBe(8);
    expect(backoffDelayMs(7, 1, 100)).toBe(100);
    expect(backoffDelayMs(10 ** 9, 1000, 30000)).toBe(30000);
    expect(backoffDelayMs(-5, 1000, 30000)).toBe(1000);
  });

  it('Retry-After: seconds, dates, clamping, zero, unreadable values', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterDelayMs('0', 5000, now)).toBe(0);
    expect(retryAfterDelayMs('3', 120000, now)).toBe(3000);
    expect(retryAfterDelayMs('99999999', 120000, now)).toBe(120000);
    expect(retryAfterDelayMs(' 2 ', 120000, now)).toBe(2000);
    expect(retryAfterDelayMs('Thu, 01 Jan 2026 00:00:10 GMT', 120000, now)).toBe(10000);
    expect(retryAfterDelayMs('Thu, 01 Jan 2026 00:00:10 GMT', 4000, now)).toBe(4000);
    expect(retryAfterDelayMs('Wed, 31 Dec 2025 23:00:00 GMT', 120000, now)).toBe(0);
    for (const bad of [undefined, null, '', 'soon', '-3', '1.5']) expect(retryAfterDelayMs(bad, 5000, now)).toBeNull();
  });

  it('body decoding: identity, gzip, deflate, raw deflate, brotli, stacked encodings; unknown or corrupt means null', () => {
    const text = '{"code":1311}';
    expect(decodeBody(Buffer.from(text), undefined)).toBe(text);
    expect(decodeBody(zlib.gzipSync(text), 'gzip')).toBe(text);
    expect(decodeBody(zlib.deflateSync(text), 'deflate')).toBe(text);
    expect(decodeBody(zlib.deflateRawSync(text), 'deflate')).toBe(text);
    expect(decodeBody(zlib.brotliCompressSync(text), 'br')).toBe(text);
    expect(decodeBody(zlib.gzipSync(zlib.brotliCompressSync(text)), 'br, gzip')).toBe(text);
    expect(decodeBody(Buffer.from(text), 'zstd')).toBeNull();
    expect(decodeBody(Buffer.from('not gzip at all'), 'gzip')).toBeNull();
  });

  it('a truncated compressed body is decoded as far as possible', () => {
    const big = zlib.gzipSync(`${'x'.repeat(5000)}"code":1311`);
    expect(decodeBody(big.subarray(0, big.length - 6), 'gzip')).toContain('xxxx');
  });

  it('permanent failure: case-insensitive match on the decoded text; undecodable bodies are retryable; no patterns never match', () => {
    const patterns = [/quota/i, /"code"\s*:\s*1311/i];
    expect(isPermanentFailure(Buffer.from('Quota exceeded'), undefined, patterns)).toBe(true);
    expect(isPermanentFailure(zlib.gzipSync('{"code": 1311}'), 'gzip', patterns)).toBe(true);
    expect(isPermanentFailure(Buffer.from('busy'), undefined, patterns)).toBe(false);
    expect(isPermanentFailure(Buffer.from('quota'), 'gzip', patterns)).toBe(false);
    expect(isPermanentFailure(Buffer.from('quota'), undefined, [])).toBe(false);
  });

  it('upstream: https or loopback http, no credentials, query or fragment; an environment value must be loopback', () => {
    expect(parseUpstream('https://api.example/anthropic/').target).toBe('https://api.example/anthropic');
    expect(parseUpstream('http://127.0.0.1:8080').target).toBe('http://127.0.0.1:8080');
    expect(parseUpstream('http://localhost:9').basePath).toBe('');
    expect(parseUpstream('http://[::1]:9').target).toBe('http://[::1]:9');
    for (const bad of ['http://api.example', 'ftp://127.0.0.1', 'nonsense', 'https://u:p@api.example', 'https://api.example/?a=1', 'https://api.example/#x']) {
      expect(() => parseUpstream(bad), bad).toThrow();
    }
    expect(() => parseUpstream('https://api.example', { fromEnv: true })).toThrow(/loopback/);
    expect(parseUpstream('http://127.0.0.1:5', { fromEnv: true }).target).toBe('http://127.0.0.1:5');
  });

  it('redaction: known secrets, credential-looking JSON fields and generic patterns', () => {
    const text = '{"api_key":"abc","Authorization":"Bearer xyz","access_token":"t","note":"key SECRETVALUE end","n":1}';
    const out = redactText(text, ['SECRETVALUE']);
    expect(out).not.toContain('abc');
    expect(out).not.toContain('xyz');
    expect(out).not.toContain('SECRETVALUE');
    expect(out).toContain('"note"');
    expect(out).toContain('"n":1');
    expect(redactText('plain text', [null, ''])).toBe('plain text');
  });
});
