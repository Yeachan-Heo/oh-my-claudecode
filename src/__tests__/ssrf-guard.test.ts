import { describe, it, expect } from 'vitest';
import { validateUrlForSSRF, validateAnthropicBaseUrl } from '../utils/ssrf-guard.js';

describe('SSRF Guard', () => {
  describe('validateUrlForSSRF', () => {
    describe('blocks private/internal IPs', () => {
      it('blocks localhost', () => {
        expect(validateUrlForSSRF('http://localhost/api')).toEqual({
          allowed: false,
          reason: "Hostname 'localhost' resolves to a blocked internal/private address",
        });
      });

      it('blocks 127.0.0.1', () => {
        expect(validateUrlForSSRF('http://127.0.0.1/api')).toEqual({
          allowed: false,
          reason: "Hostname '127.0.0.1' resolves to a blocked internal/private address",
        });
      });

      it('blocks 10.x.x.x', () => {
        expect(validateUrlForSSRF('http://10.0.0.1/api').allowed).toBe(false);
        expect(validateUrlForSSRF('http://10.255.255.255/api').allowed).toBe(false);
      });

      it('blocks 172.16-31.x.x', () => {
        expect(validateUrlForSSRF('http://172.16.0.1/api').allowed).toBe(false);
        expect(validateUrlForSSRF('http://172.31.255.255/api').allowed).toBe(false);
        expect(validateUrlForSSRF('http://172.15.0.1/api').allowed).toBe(true);
        expect(validateUrlForSSRF('http://172.32.0.1/api').allowed).toBe(true);
      });

      it('blocks 192.168.x.x', () => {
        expect(validateUrlForSSRF('http://192.168.0.1/api').allowed).toBe(false);
        expect(validateUrlForSSRF('http://192.168.255.255/api').allowed).toBe(false);
      });

      it('blocks 169.254.x.x (link-local)', () => {
        expect(validateUrlForSSRF('http://169.254.0.1/api').allowed).toBe(false);
      });

      it('blocks IPv6 loopback', () => {
        expect(validateUrlForSSRF('http://[::1]/api').allowed).toBe(false);
      });

      it('blocks IPv6 link-local', () => {
        expect(validateUrlForSSRF('http://[fe80::1]/api').allowed).toBe(false);
      });
    });

    describe('blocks dangerous protocols', () => {
      it('blocks file://', () => {
        expect(validateUrlForSSRF('file:///etc/passwd').allowed).toBe(false);
      });

      it('blocks ftp://', () => {
        expect(validateUrlForSSRF('ftp://example.com/file').allowed).toBe(false);
      });

      it('blocks gopher://', () => {
        expect(validateUrlForSSRF('gopher://example.com').allowed).toBe(false);
      });
    });

    describe('blocks credentials in URL', () => {
      it('blocks user:pass@host', () => {
        expect(validateUrlForSSRF('https://user:pass@example.com').allowed).toBe(false);
      });
    });

    describe('blocks cloud metadata endpoints', () => {
      it('blocks AWS metadata', () => {
        expect(validateUrlForSSRF('http://169.254.169.254/latest/meta-data/').allowed).toBe(false);
      });
    });

    describe('blocks encoded IP bypass forms', () => {
      it('blocks decimal-encoded IPv4 hostnames', () => {
        const result = validateUrlForSSRF('http://2130706433/');
        expect(result.allowed).toBe(false);
        expect(String(result.reason)).toMatch(/decimal-encoded IP address|blocked internal\/private address/);
      });

      it('blocks octal-encoded IPv4 hostnames', () => {
        const result = validateUrlForSSRF('http://0177.0.0.1/');
        expect(result.allowed).toBe(false);
        expect(String(result.reason)).toMatch(/octal-encoded IP address|blocked internal\/private address/);
      });
    });

    describe('allows valid URLs', () => {
      it('allows https://api.anthropic.com', () => {
        expect(validateUrlForSSRF('https://api.anthropic.com/v1').allowed).toBe(true);
      });

      it('allows https://custom-proxy.example.com', () => {
        expect(validateUrlForSSRF('https://custom-proxy.example.com/v1').allowed).toBe(true);
      });

      it('allows http:// for non-production (with warning)', () => {
        expect(validateUrlForSSRF('http://example.com').allowed).toBe(true);
      });
    });

    describe('handles invalid inputs', () => {
      it('rejects empty string', () => {
        expect(validateUrlForSSRF('').allowed).toBe(false);
      });

      it('rejects non-string input', () => {
        expect(validateUrlForSSRF(null as any).allowed).toBe(false);
        expect(validateUrlForSSRF(undefined as any).allowed).toBe(false);
      });

      it('rejects malformed URLs', () => {
        expect(validateUrlForSSRF('not-a-url').allowed).toBe(false);
      });
    });
  });

  describe('validateAnthropicBaseUrl', () => {
    it('blocks internal IPs', () => {
      expect(validateAnthropicBaseUrl('http://127.0.0.1:8080').allowed).toBe(false);
    });

    it('allows valid external URLs', () => {
      expect(validateAnthropicBaseUrl('https://api.anthropic.com').allowed).toBe(true);
    });
  });
});

describe('IPv6 non-public range coverage', () => {
  it.each([
    'fc00::1', 'fc01::1', 'fd00::1', 'fdff:ffff::1',
    'fe80::1', 'fe90::1', 'febf:ffff::1', '::', 'ff02::1',
    'FC01:0000:0000:0000:0000:0000:0000:0001', 'FDFF::1', 'FEBF::1',
  ])('blocks literal %s', (host) => {
    expect(validateUrlForSSRF(`https://[${host}]/api`).allowed).toBe(false);
  });

  it.each(['fbff::1', 'fe00::1', 'fec0::1'])(
    'preserves an address outside the blocked prefixes: %s',
    (host) => {
      expect(validateUrlForSSRF(`https://[${host}]/api`).allowed).toBe(true);
    },
  );

  it('preserves a public IPv6 endpoint', () => {
    expect(validateUrlForSSRF('https://[2001:4860:4860::8888]/api').allowed).toBe(true);
  });
});
