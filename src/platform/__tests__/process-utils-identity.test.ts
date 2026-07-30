import { describe, expect, it } from 'vitest';
import { dmtfCreationDateToTicks } from '../process-utils.js';

describe('Windows process start identity formats', () => {
  it('converts DMTF creation dates to ticks: identities (single format)', () => {
    // 2024-01-15 12:30:45.123456 UTC
    const dmtf = '20240115123045.123456+000';
    const identity = dmtfCreationDateToTicks(dmtf);
    expect(identity).toMatch(/^ticks:\d+$/);
    // Round-trip stability
    expect(dmtfCreationDateToTicks(dmtf)).toBe(identity);
  });

  it('rejects malformed DMTF strings fail-closed', () => {
    expect(dmtfCreationDateToTicks('not-a-dmtf')).toBeNull();
    expect(dmtfCreationDateToTicks('20240115123045')).toBeNull();
    expect(dmtfCreationDateToTicks('')).toBeNull();
  });

  it('applies DMTF timezone offsets when converting to ticks', () => {
    const utc = dmtfCreationDateToTicks('20240115123045.000000+000');
    const plus60 = dmtfCreationDateToTicks('20240115133045.000000+060'); // local = UTC+60min → same UTC
    expect(utc).toBeTruthy();
    expect(plus60).toBe(utc);
  });
});
