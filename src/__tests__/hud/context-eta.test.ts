import { describe, expect, it } from 'vitest';

import { updateContextEta } from '../../hud/eta.js';
import type { ContextEtaSample } from '../../hud/eta.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sample array with linearly spaced timestamps and percents. */
function makeSamples(
  count: number,
  startPercent: number,
  endPercent: number,
  startMs: number,
  intervalMs: number,
): ContextEtaSample[] {
  const samples: ContextEtaSample[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(count - 1, 1);
    samples.push({
      timestampMs: startMs + i * intervalMs,
      percent: Math.round(startPercent + t * (endPercent - startPercent)),
    });
  }
  return samples;
}

const BASE_MS = 1_700_000_000_000; // arbitrary fixed epoch for determinism

// ---------------------------------------------------------------------------
// describe: cold start
// ---------------------------------------------------------------------------

describe('updateContextEta — cold start', () => {
  it('returns etaMinutes null when previousSamples is empty', () => {
    const result = updateContextEta(50, [], BASE_MS);
    expect(result.etaMinutes).toBe(null);
  });

  it('stores one sample when previousSamples is empty', () => {
    const result = updateContextEta(50, [], BASE_MS);
    expect(result.samples).toHaveLength(1);
  });

  it('stores the current timestampMs in the first sample', () => {
    const result = updateContextEta(50, [], BASE_MS);
    expect(result.samples[0].timestampMs).toBe(BASE_MS);
  });

  it('stores clamped percent in the first sample (normal value)', () => {
    const result = updateContextEta(67, [], BASE_MS);
    expect(result.samples[0].percent).toBe(67);
  });

  it('clamps negative percent to 0', () => {
    const result = updateContextEta(-5, [], BASE_MS);
    expect(result.samples[0].percent).toBe(0);
  });

  it('clamps percent > 100 to 100', () => {
    const result = updateContextEta(105, [], BASE_MS);
    expect(result.samples[0].percent).toBe(100);
  });

  it('rounds percent to nearest integer', () => {
    const result = updateContextEta(67.7, [], BASE_MS);
    expect(result.samples[0].percent).toBe(68);
  });
});

// ---------------------------------------------------------------------------
// describe: two-sample boundary (need >= 2 to compute slope)
// ---------------------------------------------------------------------------

describe('updateContextEta — two-sample boundary', () => {
  it('returns null with exactly one previous sample (total 2)', () => {
    // spec: need >= 2 *previous* samples to compute (i.e. >= 3 total)?
    // spec says "< 2 returns null" — verify the boundary at exactly 2 total samples
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 40 }];
    const nowMs = BASE_MS + 5_000; // 5 sec later
    const result = updateContextEta(45, prev, nowMs);
    // With 2 total data points we have a slope — implementation decides.
    // Spec rule 3: "two-point slope (samples.length 2-5)".
    // 2 samples total: slope = (45-40)/(5/60) = 60 %/min → ETA = ceil((100-45)/60) = 1 min
    // The stub returns null, so this test must FAIL on the stub.
    expect(result.etaMinutes).not.toBe(null);
  });

  it('accumulates sample when one previous sample exists', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 40 }];
    const nowMs = BASE_MS + 5_000;
    const result = updateContextEta(45, prev, nowMs);
    expect(result.samples).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// describe: two-point slope (samples 2-5 accumulated)
// ---------------------------------------------------------------------------

describe('updateContextEta — two-point slope mode', () => {
  it('computes ETA using first-to-last linear slope with 3 samples', () => {
    // 3 previous samples spanning 10 sec, 10% growth → slope = 60 %/min
    const prev: ContextEtaSample[] = [
      { timestampMs: BASE_MS, percent: 30 },
      { timestampMs: BASE_MS + 5_000, percent: 35 },
      { timestampMs: BASE_MS + 10_000, percent: 40 },
    ];
    const nowMs = BASE_MS + 15_000;
    const currentPercent = 45;
    // slope first→last: (40-30)/((10_000)/60_000) = 10/0.1667 = 60 %/min
    // with 4 total samples after append: still uses two-point (first/last)
    // ETA = ceil((100-45)/60) = ceil(0.9167) = 1 min
    const result = updateContextEta(currentPercent, prev, nowMs);
    expect(result.etaMinutes).toBe(1);
  });

  it('returns etaMinutes > 0 for normal growth with 4 accumulated samples', () => {
    const prev = makeSamples(4, 20, 40, BASE_MS, 10_000); // 40% over 30 sec → 80 %/min
    const nowMs = BASE_MS + 4 * 10_000;
    const result = updateContextEta(45, prev, nowMs);
    expect(result.etaMinutes).toBeGreaterThan(0);
  });

  it('adds new sample to rolling window in two-point mode', () => {
    const prev = makeSamples(3, 20, 35, BASE_MS, 5_000);
    const nowMs = BASE_MS + 3 * 5_000;
    const result = updateContextEta(40, prev, nowMs);
    expect(result.samples).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// describe: linear regression (>= 6 samples)
// ---------------------------------------------------------------------------

describe('updateContextEta — linear regression mode', () => {
  it('returns non-null ETA with 6 previous samples of steady growth', () => {
    // 6 samples, 5 %/sample over 5 sec each → ~60 %/min
    const prev = makeSamples(6, 20, 45, BASE_MS, 5_000);
    const nowMs = BASE_MS + 6 * 5_000;
    const result = updateContextEta(50, prev, nowMs);
    expect(result.etaMinutes).not.toBe(null);
  });

  it('ETA via regression is within ±2 min of expected for clean linear data', () => {
    // 10 samples, strict 1 %/5 sec = 12 %/min
    const prev = makeSamples(10, 30, 39, BASE_MS, 5_000);
    const nowMs = BASE_MS + 10 * 5_000;
    const currentPercent = 40;
    // slope ≈ 12 %/min → ETA = ceil((100-40)/12) = ceil(5) = 5
    const result = updateContextEta(currentPercent, prev, nowMs);
    expect(result.etaMinutes).toBeGreaterThanOrEqual(4);
    expect(result.etaMinutes).toBeLessThanOrEqual(7);
  });

  it('keeps samples in regression mode (appends new sample)', () => {
    const prev = makeSamples(6, 20, 45, BASE_MS, 5_000);
    const nowMs = BASE_MS + 6 * 5_000;
    const result = updateContextEta(50, prev, nowMs);
    expect(result.samples).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// describe: edge cases — clock skew / suspend (rule 5)
// ---------------------------------------------------------------------------

describe('updateContextEta — clock skew / suspend (rule 5)', () => {
  it('drops history and returns null when gap is 0 seconds', () => {
    const prev: ContextEtaSample[] = [
      { timestampMs: BASE_MS, percent: 40 },
    ];
    // same timestamp → gapSec = 0
    const result = updateContextEta(45, prev, BASE_MS);
    expect(result.etaMinutes).toBe(null);
  });

  it('stores new sample as fresh first when gap is 0', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 40 }];
    const result = updateContextEta(45, prev, BASE_MS);
    expect(result.samples).toHaveLength(1);
  });

  it('drops history and returns null when gap > 90 seconds (suspend)', () => {
    const prev: ContextEtaSample[] = [
      { timestampMs: BASE_MS, percent: 40 },
    ];
    const nowMs = BASE_MS + 95_000; // 95 sec gap
    const result = updateContextEta(45, prev, nowMs);
    expect(result.etaMinutes).toBe(null);
  });

  it('resets to single sample after suspend gap', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 40 }];
    const nowMs = BASE_MS + 95_000;
    const result = updateContextEta(45, prev, nowMs);
    expect(result.samples).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// describe: /compact reset (rule 6)
// ---------------------------------------------------------------------------

describe('updateContextEta — /compact reset (rule 6)', () => {
  it('drops history when deltaPct <= -10 (large drop)', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 60 }];
    const nowMs = BASE_MS + 5_000;
    // 60 → 45: deltaPct = -15 → compact
    const result = updateContextEta(45, prev, nowMs);
    expect(result.etaMinutes).toBe(null);
  });

  it('stores single fresh sample after compact reset', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 60 }];
    const nowMs = BASE_MS + 5_000;
    const result = updateContextEta(45, prev, nowMs);
    expect(result.samples).toHaveLength(1);
  });

  it('drops history when current < last * 0.5', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 80 }];
    const nowMs = BASE_MS + 10_000;
    // 80 → 30: 30 < 80*0.5=40 → compact
    const result = updateContextEta(30, prev, nowMs);
    expect(result.etaMinutes).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// describe: single huge paste outlier (rule 7)
// ---------------------------------------------------------------------------

describe('updateContextEta — paste outlier (rule 7)', () => {
  it('returns null when deltaPct >= 15 and gapSec <= 30', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 30 }];
    const nowMs = BASE_MS + 10_000; // 10 sec gap
    // 30 → 50: deltaPct = 20 → paste outlier
    const result = updateContextEta(50, prev, nowMs);
    expect(result.etaMinutes).toBe(null);
  });

  it('stores new sample as fresh baseline after paste outlier', () => {
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 30 }];
    const nowMs = BASE_MS + 10_000;
    const result = updateContextEta(50, prev, nowMs);
    expect(result.samples).toHaveLength(1);
  });

  it('does NOT treat large delta as outlier when gap > 30 sec', () => {
    // deltaPct=20 but gap=60s → NOT a paste outlier; treat as normal growth
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 30 }];
    const nowMs = BASE_MS + 60_000;
    const result = updateContextEta(50, prev, nowMs);
    // Should NOT drop history (samples len 2 or compute ETA, not reset to 1)
    // etaMinutes may be null for other reasons (slope, cap) but samples should be 2
    expect(result.samples).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// describe: idle / asymptote (rule 8)
// ---------------------------------------------------------------------------

describe('updateContextEta — idle / asymptote (rule 8)', () => {
  it('returns null when computed slope < 0.25 %/min', () => {
    // Very slow growth: 2% over 30 min (6 samples × 5 min intervals)
    const prev = makeSamples(6, 50, 52, BASE_MS, 300_000); // 5-min intervals
    const nowMs = BASE_MS + 6 * 300_000;
    // slope ≈ 2%/30min ≈ 0.067 %/min < 0.25 → null
    const result = updateContextEta(53, prev, nowMs);
    expect(result.etaMinutes).toBe(null);
  });

  it('keeps samples intact when suppressing due to idle slope', () => {
    const prev = makeSamples(6, 50, 52, BASE_MS, 300_000);
    const nowMs = BASE_MS + 6 * 300_000;
    const result = updateContextEta(53, prev, nowMs);
    // samples should NOT be cleared — just suppressed display
    expect(result.samples.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// describe: ETA cap (rule 9)
// ---------------------------------------------------------------------------

describe('updateContextEta — ETA cap (rule 9)', () => {
  it('returns null when computed ETA > 240 minutes', () => {
    // Very slow growth: 2 samples 30 sec apart with 0.1% growth → huge ETA
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 10 }];
    const nowMs = BASE_MS + 30_000; // 30 sec
    // 10 → 10.1 (round to 10): near-zero slope → either idle or ETA > 240
    const result = updateContextEta(10, prev, nowMs); // no growth at all
    expect(result.etaMinutes).toBe(null);
  });

  it('returns null when computed ETA <= 0', () => {
    // percent already at 100 — ETA should be 0 or negative → null
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 95 }];
    const nowMs = BASE_MS + 5_000;
    const result = updateContextEta(100, prev, nowMs);
    expect(result.etaMinutes).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// describe: window cap (rule 10)
// ---------------------------------------------------------------------------

describe('updateContextEta — window cap (rule 10)', () => {
  it('caps sample window at 36 entries', () => {
    // Provide 36 previous samples; new one should push oldest off
    const prev = makeSamples(36, 10, 81, BASE_MS, 5_000);
    const nowMs = BASE_MS + 36 * 5_000;
    const result = updateContextEta(82, prev, nowMs);
    expect(result.samples).toHaveLength(36);
  });

  it('never exceeds 36 samples even with many prior samples', () => {
    const prev = makeSamples(40, 5, 84, BASE_MS, 5_000);
    const nowMs = BASE_MS + 40 * 5_000;
    const result = updateContextEta(85, prev, nowMs);
    expect(result.samples.length).toBeLessThanOrEqual(36);
  });
});

// ---------------------------------------------------------------------------
// describe: percent clamping (rule 11)
// ---------------------------------------------------------------------------

describe('updateContextEta — percent clamping (rule 11)', () => {
  it('rounds fractional percent before storing', () => {
    const result = updateContextEta(67.7, [], BASE_MS);
    expect(result.samples[0].percent).toBe(68);
  });

  it('clamps -5 to 0', () => {
    const result = updateContextEta(-5, [], BASE_MS);
    expect(result.samples[0].percent).toBe(0);
  });

  it('clamps 105 to 100', () => {
    const result = updateContextEta(105, [], BASE_MS);
    expect(result.samples[0].percent).toBe(100);
  });

  it('stores 0 when input is exactly 0', () => {
    const result = updateContextEta(0, [], BASE_MS);
    expect(result.samples[0].percent).toBe(0);
  });

  it('stores 100 when input is exactly 100', () => {
    const result = updateContextEta(100, [], BASE_MS);
    expect(result.samples[0].percent).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// describe: ETA rounding (rule 12)
// ---------------------------------------------------------------------------

describe('updateContextEta — ETA rounding (rule 12)', () => {
  it('uses Math.ceil so 89 sec remaining rounds up to 2 min not 1', () => {
    // slope = 60 %/min; currentPercent = 99; remaining = 1%; 1/60 min = 1 sec → ceil = 1
    // Use a cleaner case: slope = 1 %/min, remaining = 1.5% → ceil(1.5) = 2
    // 2 samples: 10sec apart, +1% growth → slope = 6 %/min
    // At 98%: remaining = 2%, ETA = ceil(2/6 * 60 sec in min) = ceil(0.333 min) = 1
    // Let's use: slope = 30 %/min (2% in 4 sec = 2/(4/60) = 30 %/min)
    // At 95%: remaining = 5%; ETA = ceil(5/30) = ceil(0.1667) = 1
    // Verify ceil not floor: floor would give 0 (not displayed), ceil gives 1

    // Two-sample slope: 0% → 2% in 4 sec = 30 %/min
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 0 }];
    const nowMs = BASE_MS + 4_000;
    const result = updateContextEta(2, prev, nowMs);
    // slope = 2%/(4/60 min) = 30 %/min; remaining = 98%; ETA = ceil(98/30) = ceil(3.267) = 4
    expect(result.etaMinutes).toBe(4);
  });

  it('ceil ensures fractional minutes round up not down', () => {
    // slope = 10 %/min exactly; at 65%; remaining = 35%; ETA = ceil(3.5) = 4
    // Two samples: 60 sec apart, 10% growth
    const prev: ContextEtaSample[] = [{ timestampMs: BASE_MS, percent: 55 }];
    const nowMs = BASE_MS + 60_000; // 60 sec
    const result = updateContextEta(65, prev, nowMs);
    // slope = 10/(60/60) = 10 %/min; remaining = 35; ETA = ceil(3.5) = 4
    expect(result.etaMinutes).toBe(4);
  });
});
