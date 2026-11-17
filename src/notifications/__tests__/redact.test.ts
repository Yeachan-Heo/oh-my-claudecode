import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { redactTokens } from '../redact.js';

describe('redactTokens', () => {
  const SWITCH = 'OMC_REDACT_KEY_SHAPES';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[SWITCH];
    delete process.env[SWITCH];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = saved;
  });

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

describe('redactTokens key-shape masking (OMC_REDACT_KEY_SHAPES=1)', () => {
  const SWITCH = 'OMC_REDACT_KEY_SHAPES';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[SWITCH];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = saved;
  });

  const setSwitch = (value: string | undefined) => {
    if (value === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = value;
  };

  // Deterministic fake secrets (no real keys, no network).
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const fake = (prefix: string, length: number): string => {
    let s = prefix;
    let x = 7;
    for (let k = 0; k < length; k++) {
      s += ALPHABET[x % ALPHABET.length];
      x = x * 31 + 7;
    }
    return s;
  };

  // [name, text containing a fake secret, the secret that must not survive redaction]
  const SAMPLES: Array<[string, string, string]> = [
    ['slack-xoxb', `tok ${fake('xoxb-', 26)} end`, fake('xoxb-', 26)],
    ['slack-xapp', `tok ${fake('xapp-', 26)} end`, fake('xapp-', 26)],
    ['telegram', `123456789:${fake('AAF-', 24)} end`, fake('AAF-', 24)],
    ['bearer', `Authorization: Bearer ${fake('', 28)}; next`, fake('', 28)],
    ['sk-ant-api', `tok ${fake('sk-ant-api03-', 32)} end`, fake('sk-ant-api03-', 32)],
    ['sk-proj', `tok ${fake('sk-proj-', 36)} end`, fake('sk-proj-', 36)],
    ['sk_live_', `tok ${fake('sk_live_', 20)} end`, fake('sk_live_', 20)],
    ['sk_test_', `tok ${fake('sk_test_', 20)} end`, fake('sk_test_', 20)],
    ['rk_live_', `tok ${fake('rk_live_', 20)} end`, fake('rk_live_', 20)],
    ['AIza', `tok ${fake('AIza', 30)} end`, fake('AIza', 30)],
    ['gsk_', `tok ${fake('gsk_', 24)} end`, fake('gsk_', 24)],
    ['xai-', `tok ${fake('xai-', 24)} end`, fake('xai-', 24)],
    ['hf_', `tok ${fake('hf_', 24)} end`, fake('hf_', 24)],
    ['ghp_', `tok ${fake('ghp_', 36)} end`, fake('ghp_', 36)],
    ['github_pat_', `tok ${fake('github_pat_', 30)} end`, fake('github_pat_', 30)],
    ['AKIA', `tok AKIA${fake('', 16).toUpperCase()} end`, fake('', 16).toUpperCase()],
  ];

  // JWT: three base64url segments (first one starts with eyJ), at least 8 characters per segment after eyJ.
  const seg1 = 'eyJ' + fake('', 33);
  const seg2 = 'eyJ' + fake('', 29);
  const seg3 = fake('', 43);
  const JWT: [string, string, string] = ['jwt', `token ${seg1}.${seg2}.${seg3} end`, seg3];

  // NAME=value assignments (names containing KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASS, PWD or CREDENTIALS)
  const ASSIGNMENTS: Array<[string, string, string]> = [
    ['KEY-equal', `run --cfg EXAMPLE_API_KEY=${fake('w', 18)} --quiet`, fake('w', 18)],
    ['TOKEN-colon', `config token: ${fake('t', 16)}, next`, fake('t', 16)],
    ['SECRET-quoted', `export MY_SECRET="${fake('s', 20)}"; echo ok`, fake('s', 20)],
    ['PASSWORD-spaces', `set PASSWORD = ${fake('p', 14)} && cd .`, fake('p', 14)],
    ['PWD-apostrophe', `dump PWD='${fake('d', 12)}' && x`, fake('d', 12)],
    ['CREDENTIALS-brackets', `cfg CREDENTIALS["main"]=${fake('c', 18)} and more`, fake('c', 18)],
  ];

  const CLEAN = [
    'Report of the stage: the module was reviewed and the tests passed.',
    'Remember: the password stays in the vault, and the token renews itself.',
    'Next step: prepare the summary for 2026-11-14 and the review notes (item 3 of 5).',
  ];

  const median = (fn: () => unknown): number => {
    fn();
    const times: number[] = [];
    for (let r = 0; r < 5; r++) {
      const start = performance.now();
      fn();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return times[2];
  };

  describe('switch off (unset, 0, true, empty): output unchanged', () => {
    it.each([undefined, '', '0', 'true'])('with value %s', (value) => {
      setSwitch(value);
      const keyShapeOnly = ['sk-proj', 'sk_live_', 'sk_test_', 'rk_live_', 'AIza', 'gsk_', 'xai-', 'hf_'];
      for (const [name, text] of SAMPLES.filter(([name]) => keyShapeOnly.includes(name))) {
        expect(redactTokens(text), name).toBe(text);
      }
      expect(redactTokens(JWT[1])).toBe(JWT[1]);
      for (const [, text] of ASSIGNMENTS) expect(redactTokens(text)).toBe(text);
      for (const text of CLEAN) expect(redactTokens(text)).toBe(text);
      // regex rules are not affected by the switch
      expect(redactTokens('token=xoxa-2-abc123def456')).toBe('token=xoxa-****');
    });
  });

  describe('switch on (OMC_REDACT_KEY_SHAPES=1)', () => {
    beforeEach(() => {
      setSwitch('1');
    });

    it('masks every key shape: no leak, prefix stays visible', () => {
      for (const [name, text, secret] of SAMPLES) {
        const result = redactTokens(text);
        expect(result.includes(secret), `${name}: leak: ${result}`).toBe(false);
        expect(result, `${name}: not masked`).not.toBe(text);
      }
      expect(redactTokens(`tok ${fake('sk-proj-', 36)} end`)).toContain('sk-****');
    });

    it('masks JWTs as eyJ***', () => {
      const [, text, secret] = JWT;
      const result = redactTokens(text);
      expect(result).not.toContain(secret);
      expect(result).toContain('eyJ***');
    });

    it('masks NAME=value assignments', () => {
      for (const [name, text, secret] of ASSIGNMENTS) {
        const result = redactTokens(text);
        expect(result.includes(secret), `${name}: leak: ${result}`).toBe(false);
        expect(result, `${name}: not masked`).not.toBe(text);
      }
    });

    it('keeps the prefix thresholds: short values stay, long enough values are masked', () => {
      expect(redactTokens('tok sk-abc1234 end')).toBe('tok sk-abc1234 end'); // 7 characters after sk-
      expect(redactTokens('tok sk-abc12345 end')).toContain('sk-****'); // 8 characters after sk-
      expect(redactTokens('tok xai-AAAA123456789012345 end')).toBe('tok xai-AAAA123456789012345 end'); // 19 after xai-
      expect(redactTokens('tok xai-AAAA1234567890123456 end')).toContain('xai-****'); // 20 after xai-
      expect(redactTokens('TOKEN=')).toBe('TOKEN=');
      expect(redactTokens('TOKEN=abc')).toContain('****');
    });

    it('leaves clean text byte-identical', () => {
      for (const text of CLEAN) expect(redactTokens(text)).toBe(text);
    });

    it('a prefix key right after a failed JWT check is still masked', () => {
      expect(redactTokens(`tok eyJ-sk-${'A'.repeat(24)} end`)).toContain('sk-****');
    });

    // Current behaviour, kept as is: the name match is a plain substring match, so these names are masked too.
    it('masks values of names that only contain a phrase (COMPASS, PASSED, BYPASS, PASSWORD)', () => {
      expect(redactTokens('COMPASS=abc12345')).toBe('COMPASS=****');
      expect(redactTokens('PASSED=yes')).toBe('PASSED=****');
      expect(redactTokens('BYPASS=1')).toBe('BYPASS=****');
      expect(redactTokens('PASSWORD=hunter2')).toBe('PASSWORD=****');
    });

    // Current behaviour, kept as is: the word "token" followed by a colon is treated as an assignment.
    it('masks the word after "token:" in ordinary prose (Invalid token: expired)', () => {
      expect(redactTokens('Invalid token: expired')).toBe('Invalid token: ****');
    });

    it('leaves a phrase name without a following = or : untouched', () => {
      expect(redactTokens('COMPASS heading north')).toBe('COMPASS heading north');
      expect(redactTokens('PASSWORD reset completed')).toBe('PASSWORD reset completed');
    });

    // P1: Mask unterminated quoted values in truncated log previews
    it('masks unterminated quoted values (closing quote cut off)', () => {
      // Simulates a password truncated at 50 chars before the closing quote
      const truncatedPassword = `PASSWORD='verylongpasswordthatgetstruncatedbeforeclosingquote`;
      const result = redactTokens(truncatedPassword);
      // Should mask the value even though the closing quote is missing
      expect(result).toContain('PASSWORD=\'****');
      expect(result).not.toContain('verylongpasswordthatgetstruncatedbeforeclosingquote');
    });

    // P1: Skip escaped quotes when locating a secret's closing quote
    it('skips escaped quotes when finding the closing quote', () => {
      // JSON.stringify result with escaped quote in the password
      const jsonWithEscapedQuote = `CONFIG='{"PASSWORD": "start\\"sensitive-suffix"}'`;
      const result = redactTokens(jsonWithEscapedQuote);
      // Should mask the entire value, not stop at the escaped quote
      expect(result).toContain('****');
      expect(result).not.toContain('sensitive-suffix');
    });

    // P2: Bound the optional-index scan to avoid quadratic retries
    it('handles degenerate bracket patterns efficiently', () => {
      // This would cause quadratic behavior if not bounded: 'KEY' repeated with brackets
      const degenerate = 'KEY' + '[KEY]'.repeat(20000);
      const start = performance.now();
      const result = redactTokens(degenerate);
      const elapsed = performance.now() - start;
      // Should complete in reasonable time (< 500ms even on slower machines)
      expect(elapsed).toBeLessThan(500);
      expect(result).toBeTruthy(); // Basic sanity check
    });

    it('long degenerate inputs without hits come back unchanged', () => {
      expect(redactTokens('eyJ-'.repeat(25000))).toBe('eyJ-'.repeat(25000));
      expect(redactTokens('a-'.repeat(50000))).toBe('a-'.repeat(50000));
    });

    // P1: Preserve literal backslashes in single-quoted assignments
    it('handles literal backslashes in single-quoted values', () => {
      // In shell, backslashes inside single quotes are literal (not escape characters)
      // A sequence like PASSWORD='abc\' TOKEN='secret' should not skip the closing quote
      const shellReply = "PASSWORD='abc\\' TOKEN='secret'";
      const result = redactTokens(shellReply);
      // Should mask both PASSWORD and TOKEN values, not expose the token name or its value
      expect(result).toContain("PASSWORD='****'");
      expect(result).toContain("TOKEN='****'");
      expect(result).not.toContain('abc\\');
      expect(result).not.toContain('secret');
    });

    it('stays near-linear on large inputs: 100 000 characters within a loose 1000 ms budget', () => {
      const base = 'Report of the stage: the module was reviewed, tests passed, result saved in the work directory. ';
      const inputs = [
        base.repeat(Math.ceil(100000 / base.length)).slice(0, 100000),
        'eyJ-'.repeat(25000),
        'a-'.repeat(50000),
      ];
      for (const input of inputs) {
        redactTokens(input); // warm-up
        const start = performance.now();
        redactTokens(input);
        expect(performance.now() - start).toBeLessThan(1000);
      }
    });

    // Timing checks depend on machine load, so they run only when OMC_REDACT_TIMING_TESTS=1.
    it.runIf(process.env.OMC_REDACT_TIMING_TESTS === '1')('is linear: 100 000 characters without hits run in at most 50 ms (median of 5)', () => {
      const base = 'Report of the stage: the module was reviewed, tests passed, result saved in the work directory. ';
      const input = base.repeat(Math.ceil(100000 / base.length)).slice(0, 100000);
      expect(input.length).toBe(100000);
      expect(median(() => redactTokens(input))).toBeLessThanOrEqual(50);
    });

    it.runIf(process.env.OMC_REDACT_TIMING_TESTS === '1')('is linear on degenerate input: at most 50 ms per 100 000 characters (median of 5)', () => {
      const degenerate = ['eyJ-'.repeat(25000), 'a-'.repeat(50000), 'sk-'.repeat(33334).slice(0, 100000)];
      for (const input of degenerate) {
        expect(input.length).toBe(100000);
        expect(median(() => redactTokens(input))).toBeLessThanOrEqual(50);
      }
    });

    it.runIf(process.env.OMC_REDACT_TIMING_TESTS === '1')('scales linearly: 200 000 characters take at most 2.5 times the time of 100 000 (plus 5 ms)', () => {
      const small = 'eyJ-'.repeat(25000);
      const large = 'eyJ-'.repeat(50000);
      const tSmall = median(() => redactTokens(small));
      const tLarge = median(() => redactTokens(large));
      expect(tLarge).toBeLessThanOrEqual(tSmall * 2.5 + 5);
    });
  });
});
