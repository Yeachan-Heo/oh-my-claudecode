import { describe, it, expect } from 'vitest';
import { validateUrlForSSRF, validateAnthropicBaseUrl } from '../ssrf-guard.js';

describe('validateUrlForSSRF', () => {
  describe('allowed URLs', () => {
    it('allows standard HTTPS URLs', () => {
      expect(validateUrlForSSRF('https://api.example.com/v1')).toEqual({ allowed: true });
    });

    it('allows standard HTTP URLs', () => {
      expect(validateUrlForSSRF('http://api.example.com/v1')).toEqual({ allowed: true });
    });

    it('allows public IP addresses', () => {
      expect(validateUrlForSSRF('https://8.8.8.8/dns')).toEqual({ allowed: true });
    });

    it('allows URLs with ports', () => {
      expect(validateUrlForSSRF('https://api.example.com:8443/v1')).toEqual({ allowed: true });
    });

    it('allows URLs with query params', () => {
      expect(validateUrlForSSRF('https://api.example.com?key=value')).toEqual({ allowed: true });
    });
  });

  describe('blocked: empty/invalid', () => {
    it('blocks empty string', () => {
      const result = validateUrlForSSRF('');
      expect(result.allowed).toBe(false);
    });

    it('blocks invalid URL', () => {
      const result = validateUrlForSSRF('not-a-url');
      expect(result.allowed).toBe(false);
    });

    it('blocks null-like inputs', () => {
      const result = validateUrlForSSRF(null as unknown as string);
      expect(result.allowed).toBe(false);
    });
  });

  describe('blocked: private IPs', () => {
    it('blocks localhost', () => {
      const result = validateUrlForSSRF('http://localhost:8080');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('blocks 127.0.0.1 (loopback)', () => {
      expect(validateUrlForSSRF('http://127.0.0.1').allowed).toBe(false);
    });

    it('blocks 10.x.x.x (Class A private)', () => {
      expect(validateUrlForSSRF('http://10.0.0.1').allowed).toBe(false);
    });

    it('blocks 172.16.x.x (Class B private)', () => {
      expect(validateUrlForSSRF('http://172.16.0.1').allowed).toBe(false);
    });

    it('blocks 172.31.x.x (Class B private upper)', () => {
      expect(validateUrlForSSRF('http://172.31.255.255').allowed).toBe(false);
    });

    it('allows 172.15.x.x (not private)', () => {
      expect(validateUrlForSSRF('http://172.15.0.1').allowed).toBe(true);
    });

    it('blocks 192.168.x.x (Class C private)', () => {
      expect(validateUrlForSSRF('http://192.168.1.1').allowed).toBe(false);
    });

    it('blocks 169.254.x.x (link-local)', () => {
      expect(validateUrlForSSRF('http://169.254.169.254').allowed).toBe(false);
    });
  });

  describe('blocked: IPv6', () => {
    it('blocks IPv6 loopback ::1', () => {
      expect(validateUrlForSSRF('http://[::1]').allowed).toBe(false);
    });

    it('blocks IPv6 unique local fc00:', () => {
      expect(validateUrlForSSRF('http://[fc00::1]').allowed).toBe(false);
    });

    it('blocks IPv6 link-local fe80:', () => {
      expect(validateUrlForSSRF('http://[fe80::1]').allowed).toBe(false);
    });
  });

  describe('blocked: protocol', () => {
    it('blocks file:// protocol', () => {
      expect(validateUrlForSSRF('file:///etc/passwd').allowed).toBe(false);
    });

    it('blocks ftp:// protocol', () => {
      expect(validateUrlForSSRF('ftp://evil.com/file').allowed).toBe(false);
    });
  });

  describe('blocked: IP encoding tricks', () => {
    it('blocks hex-encoded IP', () => {
      expect(validateUrlForSSRF('http://0x7f000001').allowed).toBe(false);
    });

    it('blocks decimal-encoded IP', () => {
      expect(validateUrlForSSRF('http://2130706433').allowed).toBe(false);
    });

    it('blocks octal-encoded IP', () => {
      expect(validateUrlForSSRF('http://0177.0.0.1').allowed).toBe(false);
    });
  });

  describe('blocked: credentials', () => {
    it('blocks URLs with username', () => {
      expect(validateUrlForSSRF('http://admin@example.com').allowed).toBe(false);
    });

    it('blocks URLs with username:password', () => {
      expect(validateUrlForSSRF('http://admin:pass@example.com').allowed).toBe(false);
    });
  });

  describe('blocked: cloud metadata paths', () => {
    it('blocks /metadata path', () => {
      expect(validateUrlForSSRF('http://example.com/metadata').allowed).toBe(false);
    });

    it('blocks /latest/meta-data (AWS)', () => {
      expect(validateUrlForSSRF('http://example.com/latest/meta-data').allowed).toBe(false);
    });

    it('blocks /computeMetadata (GCP)', () => {
      expect(validateUrlForSSRF('http://example.com/computeMetadata/v1').allowed).toBe(false);
    });

    it('allows /metadata-api (not exact match)', () => {
      expect(validateUrlForSSRF('http://example.com/api/metadata-stuff').allowed).toBe(true);
    });
  });
});

describe('validateAnthropicBaseUrl', () => {
  it('allows valid HTTPS URL', () => {
    expect(validateAnthropicBaseUrl('https://api.anthropic.com').allowed).toBe(true);
  });

  it('blocks private IPs', () => {
    expect(validateAnthropicBaseUrl('http://192.168.1.1').allowed).toBe(false);
  });

  it('allows HTTP with warning (for local dev)', () => {
    expect(validateAnthropicBaseUrl('http://api.example.com').allowed).toBe(true);
  });

  it('blocks invalid URL', () => {
    expect(validateAnthropicBaseUrl('not-a-url').allowed).toBe(false);
  });
});
