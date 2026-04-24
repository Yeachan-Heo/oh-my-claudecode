/**
 * Tests for renderEnterpriseCost element
 */

import { describe, it, expect } from 'vitest';
import { renderEnterpriseCost } from '../elements/enterprise-cost.js';
import type { RateLimits } from '../types.js';

// Strip ANSI codes for readable assertions
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function base(overrides: Partial<RateLimits> = {}): RateLimits {
  return {
    fiveHourPercent: 0,
    ...overrides,
  };
}

describe('renderEnterpriseCost', () => {
  it('returns null when limits is null', () => {
    expect(renderEnterpriseCost(null)).toBeNull();
  });

  it('returns null when limits is undefined', () => {
    expect(renderEnterpriseCost(undefined)).toBeNull();
  });

  it('returns null when enterpriseSpentUsd is undefined (no data)', () => {
    const limits = base();
    expect(renderEnterpriseCost(limits)).toBeNull();
  });

  it('renders unlimited format when enterpriseLimitUsd is null', () => {
    const limits = base({
      enterpriseSpentUsd: 3323.93,
      enterpriseLimitUsd: null,
      enterpriseCurrency: 'USD',
    });
    const result = renderEnterpriseCost(limits);
    expect(result).not.toBeNull();
    const plain = strip(result!);
    expect(plain).toBe('spent:$3,323.93');
  });

  it('renders unlimited format with no denominator or percent', () => {
    const limits = base({
      enterpriseSpentUsd: 100,
      enterpriseLimitUsd: null,
      enterpriseCurrency: 'USD',
    });
    const plain = strip(renderEnterpriseCost(limits)!);
    expect(plain).not.toContain('/');
    expect(plain).not.toContain('%');
    expect(plain).toBe('spent:$100.00');
  });

  it('renders zero spend correctly for unlimited', () => {
    const limits = base({
      enterpriseSpentUsd: 0,
      enterpriseLimitUsd: null,
      enterpriseCurrency: 'USD',
    });
    const plain = strip(renderEnterpriseCost(limits)!);
    expect(plain).toBe('spent:$0.00');
  });

  it('renders capped format with percent when limit exists', () => {
    const limits = base({
      enterpriseSpentUsd: 35.21,
      enterpriseLimitUsd: 500,
      enterpriseUtilization: 7.042,
      enterpriseCurrency: 'USD',
    });
    const result = renderEnterpriseCost(limits);
    expect(result).not.toBeNull();
    const plain = strip(result!);
    expect(plain).toBe('spent:$35.21/$500.00 (7%)');
  });

  it('applies green color below 70% utilization', () => {
    const limits = base({
      enterpriseSpentUsd: 10,
      enterpriseLimitUsd: 100,
      enterpriseUtilization: 50,
      enterpriseCurrency: 'USD',
    });
    const result = renderEnterpriseCost(limits)!;
    // Green ANSI code is \x1b[32m
    expect(result).toContain('\x1b[32m');
  });

  it('applies yellow color at 70% utilization', () => {
    const limits = base({
      enterpriseSpentUsd: 70,
      enterpriseLimitUsd: 100,
      enterpriseUtilization: 70,
      enterpriseCurrency: 'USD',
    });
    const result = renderEnterpriseCost(limits)!;
    // Yellow ANSI code is \x1b[33m
    expect(result).toContain('\x1b[33m');
  });

  it('applies red color at 90% utilization', () => {
    const limits = base({
      enterpriseSpentUsd: 90,
      enterpriseLimitUsd: 100,
      enterpriseUtilization: 90,
      enterpriseCurrency: 'USD',
    });
    const result = renderEnterpriseCost(limits)!;
    // Red ANSI code is \x1b[31m
    expect(result).toContain('\x1b[31m');
  });

  it('defaults currency to USD when enterpriseCurrency is absent', () => {
    const limits = base({
      enterpriseSpentUsd: 50,
      enterpriseLimitUsd: null,
      // no enterpriseCurrency
    });
    const plain = strip(renderEnterpriseCost(limits)!);
    expect(plain).toContain('$50.00');
  });

  it('uses ISO code prefix for non-USD currency', () => {
    const limits = base({
      enterpriseSpentUsd: 4500000,
      enterpriseLimitUsd: null,
      enterpriseCurrency: 'KRW',
    });
    const plain = strip(renderEnterpriseCost(limits)!);
    expect(plain).toBe('spent:KRW 4,500,000.00');
  });

  it('appends stale marker when stale=true', () => {
    const limits = base({
      enterpriseSpentUsd: 100,
      enterpriseLimitUsd: null,
      enterpriseCurrency: 'USD',
    });
    const result = renderEnterpriseCost(limits, true)!;
    const plain = strip(result);
    expect(plain).toContain('*');
  });

  it('does not append stale marker when stale=false', () => {
    const limits = base({
      enterpriseSpentUsd: 100,
      enterpriseLimitUsd: null,
      enterpriseCurrency: 'USD',
    });
    const result = renderEnterpriseCost(limits, false)!;
    const plain = strip(result);
    expect(plain).not.toContain('*');
  });

  it('formats large numbers with comma separators', () => {
    const limits = base({
      enterpriseSpentUsd: 1234567.89,
      enterpriseLimitUsd: null,
      enterpriseCurrency: 'USD',
    });
    const plain = strip(renderEnterpriseCost(limits)!);
    expect(plain).toBe('spent:$1,234,567.89');
  });
});
