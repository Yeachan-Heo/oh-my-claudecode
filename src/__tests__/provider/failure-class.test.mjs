/* global process */
// Failure classes of a provider worker run: decision table of failureClass.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { failureClass } = require('../../../scripts/provider/lib/failure-class.cjs');
const { FAILURE_CLASSES } = require('../../../scripts/provider/lib/vocab.cjs');

// Provider error codes are part of the profile; the test profile carries the same values as the original setup.
const profile = { errorCodes: { quota: [1308, 1310], throttle: [1305] } };

describe.skipIf(process.platform === 'win32')('provider failure classes', () => {
  it('(1) failureClass: 401; 429 without code; 429 with 1308; 1310; 1305; 500; 502; 529; advisor timeout; advisor error; text 429 with exit 0; text 429 with exit 1', () => {
    const cases = [
      [{ status: 401 }, FAILURE_CLASSES.AUTH],
      [{ status: 429 }, FAILURE_CLASSES.THROTTLE],
      [{ status: 429, providerCode: 1308 }, FAILURE_CLASSES.QUOTA],
      [{ providerCode: '1310' }, FAILURE_CLASSES.QUOTA],
      [{ providerCode: 1305 }, FAILURE_CLASSES.THROTTLE],
      [{ status: 500 }, FAILURE_CLASSES.INFRA],
      [{ status: 502 }, FAILURE_CLASSES.INFRA],
      [{ status: 529 }, FAILURE_CLASSES.INFRA],
      [{ advisor: 'timeout', status: 429 }, FAILURE_CLASSES.ADVISOR],
      [{ advisor: 'error', status: 500 }, FAILURE_CLASSES.ADVISOR],
      [{ text: 'test printed 429 and exited with code 0' }, FAILURE_CLASSES.OTHER],
      [{ text: '429' }, FAILURE_CLASSES.OTHER],
    ];
    for (const [input, expected] of cases) {
      expect(failureClass(input, profile), JSON.stringify(input)).toBe(expected);
    }
  });

  it('(1b) failureClass: error text of the API and the transcript error field; exhausted percentage 100; advisor ok does not override; no observation gives other', () => {
    const cases = [
      [{ text: '{"isApiErrorMessage":true,"text":"API Error: 429 {\\"error\\":{\\"code\\":1308}}"}' }, FAILURE_CLASSES.QUOTA],
      [{ text: '{"error":{"type":"billing_error","message":"Credit balance is too low"}}' }, FAILURE_CLASSES.QUOTA],
      [{ text: 'authentication_failed: invalid key' }, FAILURE_CLASSES.AUTH],
      [{ text: 'API Error: 401' }, FAILURE_CLASSES.AUTH],
      [{ text: 'API Error: 403' }, FAILURE_CLASSES.AUTH],
      [{ text: 'API Error: 429' }, FAILURE_CLASSES.THROTTLE],
      [{ text: 'API Error: 500' }, FAILURE_CLASSES.INFRA],
      [{ text: 'API Error: 529' }, FAILURE_CLASSES.INFRA],
      [{ text: 'API Error: 429 with code 1305' }, FAILURE_CLASSES.THROTTLE],
      [{ status: 500, quota: { data: { limits: [{ percentage: 100 }] } } }, FAILURE_CLASSES.QUOTA],
      [{ status: 500, quota: { data: { limits: [{ percentage: 87 }] } } }, FAILURE_CLASSES.INFRA],
      [{ quota: { data: { limits: [{ percentage: 87 }] } } }, FAILURE_CLASSES.OTHER],
      [{ quota: [{ percentage: 100 }] }, FAILURE_CLASSES.QUOTA],
      [{ advisor: 'ok', status: 401 }, FAILURE_CLASSES.AUTH],
      [{ advisor: 'empty-question' }, FAILURE_CLASSES.OTHER],
      [{}, FAILURE_CLASSES.OTHER],
    ];
    for (const [input, expected] of cases) {
      expect(failureClass(input, profile), JSON.stringify(input)).toBe(expected);
    }
  });

  it('(1c) failureClass: without profile error codes the text is not scanned for codes (no empty alternation)', () => {
    expect(failureClass({ text: 'API Error: 1308' }, {})).toBe(FAILURE_CLASSES.OTHER);
    expect(failureClass({ text: 'API Error: 1308' }, profile)).toBe(FAILURE_CLASSES.QUOTA);
  });
});
