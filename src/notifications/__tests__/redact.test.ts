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

    describe('quoted values', () => {
      it('masks an unterminated quoted value up to the end of the line (closing quote cut off)', () => {
        expect(redactTokens("PASSWORD='verylongpasswordthatgetstruncated")).toBe("PASSWORD='****");
        expect(redactTokens('PASSWORD="abc\nTOKEN=x')).toBe('PASSWORD="****\nTOKEN=****');
      });

      it('skips an escaped quote in double quotes', () => {
        const input = `CONFIG='{"PASSWORD": "start\\"sensitive-suffix"}'`;
        expect(redactTokens(input)).toBe(`CONFIG='{"PASSWORD": "****"}'`);
      });

      it('treats a backslash in single quotes as a literal character', () => {
        expect(redactTokens("PASSWORD='abc\\' TOKEN='secret'")).toBe("PASSWORD='****' TOKEN='****'");
      });

      it('does not let a backslash escape a line break', () => {
        expect(redactTokens(['PASSWORD="abc\\', 'TOKEN="canary"'].join('\n'))).toBe('PASSWORD="****\nTOKEN="****"');
      });
    });

    // A value can end at a quote that really opens the next value, so that the next assignment's name is
    // inside the first value. The value after that name must be masked anyway.
    describe('an assignment name inside the previous value', () => {
      it('quote taken as closing: escaped quote in a double-quoted value', () => {
        expect(redactTokens('PASSWORD="abc\\" TOKEN="canary"')).toBe('PASSWORD="****"****"');
      });

      // The Bearer and Bot rules match up to the next space, so their match includes the closing quote.
      it('quote inside the match of the Bearer rule', () => {
        expect(redactTokens('TOKEN="Bearer abc" PASSWORD="canary"')).toBe('TOKEN="**** PASSWORD="****"');
      });

      it('quote inside the match of the Bot rule, which has no word boundary (robot)', () => {
        expect(redactTokens('TOKEN="robot abc" PASSWORD="canary"')).toBe('TOKEN="**** PASSWORD="****"');
      });

      it('bare value that ends at the quote opening the next value', () => {
        expect(redactTokens('KEY=abc:TOKEN="canary"')).toBe('KEY=****"****"');
        expect(redactTokens("KEY=a:PASSWORD='canary'")).toBe("KEY=****'****'");
      });

      it('merges overlapping masks: the second value ends after the first', () => {
        expect(redactTokens(`TOKEN="x PASSWORD='canary" more'`)).toBe(`TOKEN="****'`);
      });

      it('two names nested in one value: the value of the first one runs past the end of the outer value', () => {
        expect(redactTokens(`KEY="TOKEN='aa PWD=b" cc'`)).toBe(`KEY="****'`);
      });

      it('a name after a key is examined too (sk-...-PASSWORD=secret)', () => {
        expect(redactTokens('sk-abcdefghijkl-PASSWORD=secretvalue')).toBe('sk-****=****');
      });

      it('a JWT that starts inside a key is masked up to its own end', () => {
        expect(redactTokens('sk-abcdefghijkl-eyJabcdefghij.abcdefgh.abcdefgh')).toBe('sk-****');
      });
    });

    describe('prefix shapes and assignments are independent rules', () => {
      it('masks the value of an assignment whose name has a key prefix shape (and the name, which is a key shape)', () => {
        expect(redactTokens('hf_token_long_variable_name=canary')).toBe('hf_****=****');
      });

      it('masks a key that contains a name phrase and is followed by a colon', () => {
        expect(redactTokens('gsk_abcKEYdefghijklmnopqrstuvwxyz: ok')).toBe('gsk_****: ****');
      });
    });

    // The token rules (xox*, xapp-, Telegram, Bearer, Bot, sk-ant-api, gh*_, github_pat_, AKIA) and the scan all
    // look at the original text. A token rule that changes the name of an assignment, or a quote, must not hide
    // the assignment from the scan: the value is masked whatever the rules do to the name.
    describe('token rules do not hide assignments from the scan (grid)', () => {
      // [name, what the token rules leave visible of it (switch off), what is visible with the switch on]
      const NAMES: Array<[string, string, string]> = [
        ['ghp_PASSWORD', 'ghp_****', 'ghp_****'],
        ['gho_TOKEN', 'gho_****', 'gho_****'],
        ['ghs_SECRET', 'ghs_****', 'ghs_****'],
        ['github_pat_API_KEY', 'github_pat_****', 'github_pat_****'],
        ['xoxb-PASSWORD', 'xoxb-****', 'xoxb-****'],
        ['xoxp-token', 'xoxp-****', 'xoxp-****'],
        ['xoxa-API-KEY', 'xoxa-****', 'xoxa-****'],
        ['xoxe-pwd', 'xoxe-****', 'xoxe-****'],
        ['xapp-SECRET', 'xapp-****', 'xapp-****'],
        ['sk-ant-api_TOKEN', 'sk-ant-api****', 'sk-****'], // the prefix rule sees the whole key as well
        ['AKIA' + 'ABCDEFGHIJKEY123', 'AKIA****', 'AKIA****'],
        ['123456789:AAAAAAAAAAAAAAAAAAAA_PASSWORD', '123456789:****', '123456789:****'],
        ['/bot123456789:AAAAAAAAAAAAAAAAAAAA_PASSWORD', '/bot123456789:****', '/bot123456789:****'],
        // not matched by any token rule: the same with the switch on and off
        ['xoxb_SECRET', 'xoxb_SECRET', 'xoxb_SECRET'],
      ];
      // [label, value as written, with the switch on, with the switch off]
      const VALUES: Array<[string, string, string, string]> = [
        ['bare', 'canary', '****', 'canary'],
        ['double quotes', '"two words"', '"****"', '"two words"'],
        ['single quotes', "'two words'", "'****'", "'two words'"],
        ['escaped quote', '"start\\"sensitive-suffix"', '"****"', '"start\\"sensitive-suffix"'],
        ['escaped quote and a Bearer word', '"start\\" Bearer sensitive-suffix"', '"****', '"start\\" Bearer ****'],
      ];
      const SEPARATORS = ['=', ': ', ' = '];

      it.each(NAMES)('%s', (name, visibleOff, visibleOn) => {
        for (const [label, value, masked, plain] of VALUES) {
          for (const separator of SEPARATORS) {
            const input = `${name}${separator}${value}`;
            setSwitch('1');
            expect(redactTokens(input), `on, ${label}, ${JSON.stringify(separator)}`).toBe(`${visibleOn}${separator}${masked}`);
            setSwitch(undefined);
            expect(redactTokens(input), `off, ${label}, ${JSON.stringify(separator)}`).toBe(`${visibleOff}${separator}${plain}`);
          }
        }
      });

      it('the example from review: ghp_PASSWORD=canary', () => {
        expect(redactTokens('ghp_PASSWORD=canary')).toBe('ghp_****=****');
        setSwitch(undefined);
        expect(redactTokens('ghp_PASSWORD=canary')).toBe('ghp_****=canary'); // unchanged without the switch
      });

      it('a word that a token rule masks as a whole, and the part of its assignment that is left', () => {
        expect(redactTokens('Bearer PASSWORD=canary')).toBe('Bearer ****');
        expect(redactTokens('robot TOKEN=canary')).toBe('robot ****');
        expect(redactTokens('Bot KEY: "two words"')).toBe('Bot **** "****"'); // the Bot rule stops at the space
      });

      it('a token as the value of an assignment, and an assignment next to a token', () => {
        expect(redactTokens('TOKEN=xoxb-abc123 PASSWORD=canary')).toBe('TOKEN=**** PASSWORD=****');
        expect(redactTokens('xoxb-abc123 PASSWORD=canary ghp_abc123')).toBe('xoxb-**** PASSWORD=**** ghp_****');
        expect(redactTokens('KEY=123456789:AAAAAAAAAAAAAAAAAAAAAAAA next')).toBe('KEY=**** next');
      });

      it('with no key shape in the text the output is what the token rules alone give', () => {
        const frozen = (text: string): string =>
          text
            .replace(/\b(xox[bpae]-)[A-Za-z0-9-]+/g, '$1****')
            .replace(/\b(xapp-)[A-Za-z0-9-]+/g, '$1****')
            .replace(/\/bot(\d+):[A-Za-z0-9_-]+/g, '/bot$1:****')
            .replace(/\b(\d{8,12}):[A-Za-z0-9_-]{20,}\b/g, '$1:****')
            .replace(/(Bearer\s+)\S+/gi, '$1****')
            .replace(/(Bot\s+)\S+/gi, '$1****')
            .replace(/\b(sk-ant-api)[A-Za-z0-9_-]+/g, '$1****')
            .replace(/\b(ghp_)[A-Za-z0-9]+/g, '$1****')
            .replace(/\b(gho_)[A-Za-z0-9]+/g, '$1****')
            .replace(/\b(ghs_)[A-Za-z0-9]+/g, '$1****')
            .replace(/\b(github_pat_)[A-Za-z0-9_]+/g, '$1****')
            .replace(/\b(AKIA)[A-Z0-9]{16}\b/g, '$1****');
        // pieces without a name phrase, a key prefix of the scan or eyJ: the scan finds nothing in any combination
        const pieces = ['xoxb-', 'xoxp-', 'xoxa-', 'xapp-', '/bot', '/bot123456:', '123456789:', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'AKIA',
          'ABCDEFGHIJKLMNOP', 'Bearer ', 'bearer\t', 'Bot ', 'robot ', 'abc', 'x', '12345678', ':', '-', '_', ' ', '\n', '"', "'", '*', '****',
          '.', ',', 'AAAAAAAAAAAAAAAAAAAAAAAA', '(', ')', '/'];
        let seed = 20261117;
        const next = (): number => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        for (let t = 0; t < 4000; t++) {
          let text = '';
          const length = 1 + Math.floor(next() * 24);
          for (let k = 0; k < length; k++) text += pieces[Math.floor(next() * pieces.length)];
          setSwitch('1');
          const on = redactTokens(text);
          setSwitch(undefined);
          const off = redactTokens(text);
          expect(on, JSON.stringify(text)).toBe(frozen(text));
          expect(off, JSON.stringify(text)).toBe(frozen(text));
        }
      });
    });

    describe('index between the name and the separator', () => {
      it('skips closed indexes', () => {
        expect(redactTokens("CONFIG_PASSWORD['key1']['key2']=secret")).toBe("CONFIG_PASSWORD['key1']['key2']=****");
      });

      it('recovers from an index that is never closed: the separator after it and the next assignment are still found', () => {
        expect(redactTokens('CREDENTIALS["abc TOKEN=canary')).toBe('CREDENTIALS["abc TOKEN=****');
        expect(redactTokens('PASSWORD[=hunter2')).toBe('PASSWORD[=****');
      });

      it('skips an index of any length', () => {
        const index = (length: number) => '"' + 'a'.repeat(length - 2) + '"';
        for (const length of [64, 65, 300]) {
          expect(redactTokens(`CREDENTIALS[${index(length)}]=secret TOKEN=canary`)).toBe(`CREDENTIALS[${index(length)}]=**** TOKEN=****`);
        }
      });

      it('has no limit on how far the separator is from the name', () => {
        expect(redactTokens('KEY' + '[a]'.repeat(80) + '=secret')).toBe('KEY' + '[a]'.repeat(80) + '=****');
        expect(redactTokens('KEY' + '[a]'.repeat(100) + '=secret TOKEN=canary')).toBe('KEY' + '[a]'.repeat(100) + '=**** TOKEN=****');
      });

      it('skips stray closing brackets and quotes, and spaces and tabs around the separator', () => {
        expect(redactTokens('KEY]=x')).toBe('KEY]=****');
        expect(redactTokens('KEY["a"]]"=x')).toBe('KEY["a"]]"=****');
        expect(redactTokens('KEY\t=x')).toBe('KEY\t=****');
        expect(redactTokens('KEY \t: \tx')).toBe('KEY \t: \t****');
      });

      it('continues past spaces and tabs before an index, inside it and between index parts', () => {
        expect(redactTokens('CREDENTIALS ["main"] = "canary"')).toBe('CREDENTIALS ["main"] = "****"');
        expect(redactTokens('CREDENTIALS\t["main"]\t=\t"canary"')).toBe('CREDENTIALS\t["main"]\t=\t"****"');
        expect(redactTokens('KEY [ "a" ] [ "b" ] : canary')).toBe('KEY [ "a" ] [ "b" ] : ****');
        expect(redactTokens('KEY ] = canary')).toBe('KEY ] = ****');
        expect(redactTokens('PASSWORD [=hunter2 ]')).toBe('PASSWORD [=**** ]');
      });

      // Every blank (none, a space, a tab, a run of 70) in every place between the name and the separator,
      // together and one place at a time, for each shape of index.
      it('masks the value whichever blanks stand around the index parts (grid)', () => {
        const blanks = ['', ' ', '\t', ' '.repeat(70), ' \t '];
        const indexes = ['"a"', "'a'", 'a', '1', '"a b"', '', '"a]b"', "'a]b'", '"]"', '"]]a]"', '"a\\"]b"', "'a\\']b'", '"[a]"', '"a=b]c:d"'];
        const places = ['n', 'o1', 'i1', 'c1', 'o2', 'i2', 'c2', 's', 'v']; // name, open, inside, close, ..., separator, value
        const build = (at: (place: string) => string, index: string, value: string): string =>
          `CREDENTIALS${at('n')}[${at('o1')}${index}${at('i1')}]${at('c1')}[${at('o2')}${index}${at('i2')}]${at('c2')}=${at('s')}${value}`;
        const exact = (actual: string, expected: string, label: string) => expect(actual === expected, label).toBe(true);
        let cases = 0;
        for (const index of indexes) {
          for (const blank of blanks) {
            const variants = [(): string => blank, ...places.map((place) => (p: string): string => (p === place ? blank : ''))];
            for (const at of variants) {
              const input = build(at, index, 'canary');
              exact(redactTokens(input), build(at, index, '****'), JSON.stringify(input));
              cases++;
            }
          }
        }
        expect(cases).toBe(indexes.length * blanks.length * (places.length + 1));
      });

      it('a quoted key can contain a ] (the example from review) and the key of a later index too', () => {
        expect(redactTokens('CREDENTIALS["a]b"]="canary"')).toBe('CREDENTIALS["a]b"]="****"');
        expect(redactTokens("CREDENTIALS['a]b']=canary")).toBe("CREDENTIALS['a]b']=****");
        expect(redactTokens('CREDENTIALS["a]b"]["c]d"]: canary TOKEN=x')).toBe('CREDENTIALS["a]b"]["c]d"]: **** TOKEN=****');
        expect(redactTokens('CREDENTIALS [ "a]b" ] = canary')).toBe('CREDENTIALS [ "a]b" ] = ****');
        expect(redactTokens('CREDENTIALS["a\\"]b"]=canary')).toBe('CREDENTIALS["a\\"]b"]=****'); // escaped quote
        expect(redactTokens("CREDENTIALS['a\\']b']=canary")).toBe("CREDENTIALS['a\\']b']=****"); // escape in single quotes
      });

      it('a quoted key that is never closed, or is not followed by ], does not hide the next assignment', () => {
        expect(redactTokens('CREDENTIALS["a]b TOKEN=canary')).toBe('CREDENTIALS["a]b TOKEN=****');
        expect(redactTokens('CREDENTIALS["a]b" x TOKEN=canary')).toBe('CREDENTIALS["a]b" x TOKEN=****');
      });

      it('reads a [ both ways: an index that swallows the separator cannot hide the value', () => {
        expect(redactTokens('PASSWORD[=hunter2 ]')).toBe('PASSWORD[=**** ]');
        expect(redactTokens('PASSWORD["=hunter2"]')).toBe('PASSWORD["=****"]');
        expect(redactTokens('KEY[=a][=b]')).toBe('KEY[=****');
      });

      it('an index can contain = or : and the names of other assignments, which are masked on their own', () => {
        expect(redactTokens('KEY[a=b]=secret')).toBe('KEY[a=b]=****');
        expect(redactTokens('KEY[x:y]: secret')).toBe('KEY[x:y]: ****');
        expect(redactTokens('KEY[ TOKEN=canary ]=x')).toBe('KEY[ TOKEN=**** ]=****');
        expect(redactTokens('KEY[ TOKEN: canary ]=x')).toBe('KEY[ TOKEN: **** ]=****');
        expect(redactTokens('CREDENTIALS["registry:5000"]=secret')).toBe('CREDENTIALS["registry:5000"]=****');
      });
    });

    // No fixed length may leave a secret visible. The name, the index and the distance between the name and the
    // separator are each tried just below, at, just above and far above 64, 64 and 256 characters, with each
    // kind of secret, and must give the same result.
    describe('lengths around 64 and 256 characters leave nothing visible (grid)', () => {
      const exact = (actual: string, expected: string, label: string) => expect(actual === expected, label).toBe(true);
      const identifier = (length: number) => 'A'.repeat(length - '_PASSWORD'.length) + '_PASSWORD';
      const keyName = (length: number) => 'hf_' + 'a'.repeat(length - '_PASSWORD'.length - 3) + '_PASSWORD';

      it.each([63, 64, 65, 66, 128, 100000])('identifier of %i characters: bare value, quoted value, colon, key shape', (length) => {
        const plain = identifier(length);
        expect(plain.length).toBe(length);
        exact(redactTokens(`${plain}=canary`), `${plain}=****`, 'bare');
        exact(redactTokens(`${plain}="two words"`), `${plain}="****"`, 'quoted');
        exact(redactTokens(`${plain}: canary`), `${plain}: ****`, 'colon');
        exact(redactTokens(`${keyName(length)}=canary`), 'hf_****=****', 'a name that is a key shape');
        exact(redactTokens(`${'a'.repeat(length - 3)}KEY a`), `${'a'.repeat(length - 3)}KEY a`, 'no separator');
      });

      it.each([0, 1, 63, 64, 65, 66, 128, 100000])('index of %i characters between the name and the separator', (length) => {
        const index = `[${'a'.repeat(length)}]`;
        exact(redactTokens(`KEY${index}=canary`), `KEY${index}=****`, 'bare');
        exact(redactTokens(`KEY${index}="two words"`), `KEY${index}="****"`, 'quoted');
        exact(redactTokens(`hf_${'a'.repeat(20)}_KEY${index}=canary`), `hf_****${index}=****`, 'a name that is a key shape');
        exact(redactTokens(`KEY[${'a'.repeat(length)} TOKEN=canary`), `KEY[${'a'.repeat(length)} TOKEN=****`, 'never closed');
      });

      it.each([255, 256, 257, 512, 100000])('%i characters between the name and the separator', (length) => {
        for (const [label, filler] of [['quotes', '"'.repeat(length)], ['indexes', '[a]'.repeat(Math.ceil(length / 3))]]) {
          exact(redactTokens(`KEY${filler}=canary`), `KEY${filler}=****`, `${label}, bare`);
          exact(redactTokens(`KEY${filler}="two words"`), `KEY${filler}="****"`, `${label}, quoted`);
          exact(redactTokens(`hf_${'a'.repeat(20)}_KEY${filler}=canary`), `hf_****${filler}=****`, `${label}, key shape`);
        }
      });
    });

    // The minimum lengths are thresholds that say what a key is, not limits on how far a scan goes: a run that is
    // shorter is not a key. They apply to text that has not been cut (see redactedPreview).
    describe('minimum lengths of key shapes: one below, at and one above', () => {
      const thresholds: Array<[prefix: string, min: number]> = [
        ['sk-', 8], ['sk_live_', 16], ['sk_test_', 16], ['rk_', 16], ['AIza', 20], ['gsk_', 20], ['xai-', 20], ['hf_', 20],
      ];
      it.each(thresholds)('%s needs %i characters after it', (prefix, min) => {
        const text = (length: number) => `tok ${prefix}${'a'.repeat(length)} end`;
        expect(redactTokens(text(min - 1))).toBe(text(min - 1));
        expect(redactTokens(text(min))).toBe(`tok ${prefix}**** end`);
        expect(redactTokens(text(min + 1))).toBe(`tok ${prefix}**** end`);
        expect(redactTokens(text(100000))).toBe(`tok ${prefix}**** end`);
      });

      it.each([[10, 8, 8, false], [11, 8, 8, true], [12, 8, 8, true], [20, 7, 8, false], [20, 8, 8, true], [20, 9, 8, true], [20, 8, 7, false], [20, 8, 9, true]])(
        'a JWT with segments of %i, %i and %i characters (the first one counts eyJ): masked %s',
        (first, second, third, masked) => {
          const jwt = `eyJ${'a'.repeat(first - 3)}.${'b'.repeat(second)}.${'c'.repeat(third)}`;
          expect(redactTokens(`tok ${jwt} end`)).toBe(masked ? 'tok eyJ*** end' : `tok ${jwt} end`);
        },
      );
    });

    describe('JWT rejection', () => {
      const validJwt = 'eyJ' + 'A'.repeat(20) + '.' + 'B'.repeat(20) + '.' + 'C'.repeat(20);
      const rejected = [
        ['second segment too short', 'eyJabcdefghij.abc.defghijkl'],
        ['third segment too short', 'eyJabcdefghij.abcdefgh.xyz'],
        ['no third segment', 'eyJabcdefghij.abcdefghijk'],
        ['first segment too short', 'eyJabc.abcdefgh.abcdefgh'],
      ];

      it.each(rejected)('%s: stays unchanged, a later JWT and a later assignment are still masked', (_name, text) => {
        expect(redactTokens(text)).toBe(text);
        expect(redactTokens(`${text} ${validJwt}`)).toBe(`${text} eyJ***`);
        expect(redactTokens(`${text} TOKEN=canary`)).toBe(`${text} TOKEN=****`);
      });
    });

    // Property check with a seeded generator. Every fragment that carries a canary must lose it, whatever the
    // fragments before and after it look like (quotes, backslashes, line breaks, Bearer/Bot words, nested names).
    describe('no canary survives (generated inputs)', () => {
      const names = ['TOKEN', 'PASSWORD', 'api_key', 'hf_token_long_name', 'CREDENTIALS["k"]', 'CREDENTIALS["registry:5000"]', "KEY['a=b']", 'MY_SECRET', 'pwd', 'KEY',
        `${'A'.repeat(70)}_TOKEN`, `KEY["${'k'.repeat(70)}"]`, `KEY[${'x'.repeat(300)}]`, `KEY${'"'.repeat(300)}`];
      // a name nested in a value must not contain a quote character itself
      const nestedNames = names.map((name) => name.replace(/["']/g, ''));
      const separators = ['=', ':', ' = ', ': '];
      const bareLeads = ['', 'Bearer ', 'Bot ', 'robot ', 'abc\\', 'abc:', 'ab\\\\', 'x:TOKEN=', "a:PASSWORD='"];
      const quotedLeads = [...bareLeads, 'a b '];
      const joiners = [' ', '\n', '\r\n', '; ', ', '];
      // fragments without a canary that leave an odd quote, backslash or Bearer/Bot word behind
      const junk = ['PASSWORD="abc\\"', "PASSWORD='abc\\'", 'PASSWORD="abc\\', 'KEY="abc', "KEY='abc", 'robot "', 'Bearer abc"',
        'x "', "x '", 'TOKEN=a:', 'KEY[', 'KEY["abc', '"', "'", '\\', '[', ']', 'sk-abcdefghijkl'];

      it('masks every canary in 2000 generated inputs', () => {
        let seed = 20261117;
        const rand = (): number => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
        let canaries = 0;
        const canary = (): string => `canary${(canaries++).toString(36)}z`;
        const fragment = (): [text: string, found: string[]] => {
          if (rand() < 0.25) return [pick(junk), []];
          const c = canary();
          const kind = rand();
          if (kind < 0.15) {
            return [`{"${pick(nestedNames)}"${pick([':', ': ', ' : '])}"${pick(['', 'a b ', 'Bearer '])}${c}"}`, [c]];
          }
          if (kind < 0.3) {
            // two names nested in one value; the value of the first one can run past the end of the outer value
            const outer = pick(['"', "'"]);
            const inner = pick(['"', "'", '']);
            const [c2, c3] = [canary(), canary()];
            const tail = inner && inner !== outer ? c3 : 'tail';
            const nested = `${pick(nestedNames)}=${inner}${c} ${pick(nestedNames)}${pick(['=', ': '])}${c2}${outer}${tail}${inner}`;
            return [`${pick(names)}=${outer}outer ${nested}`, inner && inner !== outer ? [c, c2, c3] : [c, c2]];
          }
          if (kind < 0.4) {
            // a name right after a key: the key mask must not hide it
            return [`${pick(['sk-abcdefghijkl', 'hf_abcdefghijklmnopqrstu', 'gsk_abcdefghijklmnopqrstu'])}-${pick(nestedNames)}=${c}`, [c]];
          }
          const quote = pick(['', '"', "'", '"+', "'+"]); // a trailing + means: the closing quote is missing
          const open = quote.slice(0, 1);
          const close = quote.length === 1 ? quote : '';
          return [`${pick(names)}${pick(separators)}${open}${pick(open ? quotedLeads : bareLeads)}${c}${close}`, [c]];
        };
        let masked = 0;
        for (let t = 0; t < 2000; t++) {
          const parts: string[] = [];
          const found: string[] = [];
          const count = 1 + Math.floor(rand() * 6);
          for (let f = 0; f < count; f++) {
            const [text, cs] = fragment();
            parts.push(text);
            found.push(...cs);
            if (f < count - 1) parts.push(pick(joiners));
          }
          const input = parts.join('');
          const output = redactTokens(input);
          const leaked = found.filter((c) => output.includes(c));
          expect(leaked, `${JSON.stringify(input)} -> ${JSON.stringify(output)}`).toEqual([]);
          if (found.length > 0) masked++;
        }
        expect(masked).toBeGreaterThan(1800); // the generator really produces canaries
      });
    });

    // Inputs for which a quadratic scan takes seconds; the strict timing tests below are off by default, so this
    // loose check is the one that runs everywhere.
    const degenerateInputs: Array<[name: string, input: string]> = [
      ['prose', 'The module was reviewed, the tests passed and the result was saved in the work directory. '.repeat(1200)],
      ['eyJ- repeated', 'eyJ-'.repeat(30000)],
      ['a- repeated', 'a-'.repeat(60000)],
      ['sk- repeated', 'sk-'.repeat(40000)],
      ['a key followed by a name', 'sk-abcdefghijkl-PASSWORD=x '.repeat(4000)],
      ['JWTs in a row', 'eyJabcdefghij.abcdefgh.'.repeat(5000)],
      ['index openers', 'KEY['.repeat(30000)],
      ['indexes of one character', 'KEY' + '[KEY]'.repeat(24000)],
      ['256 index openers per name', ('KEY' + '['.repeat(256)).repeat(460)],
      ['index openers that share one closing bracket', 'KEY['.repeat(30000) + ']'],
      ['a name followed by 100 000 quotes', 'KEY' + '"'.repeat(120000) + '=x'],
      ['openers, one closing bracket, spaces', 'KEY' + '['.repeat(60000) + ']' + ' '.repeat(60000) + '=x'],
      ['names whose index holds a separator', 'KEY[=a]'.repeat(18000)],
      ['one identifier of 120 000 characters', 'A'.repeat(120000) + '_KEY=x'],
      ['names after long runs of spaces', ('KEY' + ' '.repeat(1000)).repeat(120)],
      ['names that are values of names', 'a_KEY='.repeat(20000)],
      ['unterminated quotes', 'KEY="'.repeat(24000)],
      ['bare values that contain names', 'KEY=a:'.repeat(20000) + '"'],
      ['escapes at the end of the quote', 'KEY="\\'.repeat(20000)],
      ['alternating quote types', `PASSWORD="a'TOKEN='b"c'KEY="`.repeat(5000)],
      ['names followed by blanks and index openers', 'KEY [ '.repeat(20000)],
      ['index parts separated by blanks', 'KEY' + ' ["a"]'.repeat(20000)],
      ['quoted index keys that hold a closing bracket', 'KEY' + '["a]"]'.repeat(20000)],
      ['quoted index keys with escapes and blanks', "KEY" + " [ 'a\\' ] ".repeat(20000)],
      ['quoted index openers, one closing quote', 'KEY' + '["'.repeat(60000) + '"]'],
      ['names followed by long blank runs', ('KEY' + ' '.repeat(97) + '[').repeat(1100)],
    ];

    it.each(degenerateInputs)('stays near-linear on %s: more than 100 000 characters within a loose 1000 ms budget', (_name, input) => {
      expect(input.length).toBeGreaterThan(100000);
      redactTokens(input); // warm-up
      const start = performance.now();
      redactTokens(input);
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it('long inputs without any hit come back unchanged', () => {
      for (const [name, input] of degenerateInputs.filter(([name]) => ['eyJ- repeated', 'a- repeated', 'index openers', 'indexes of one character'].includes(name))) {
        expect(redactTokens(input) === input, name).toBe(true);
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
