import { describe, it, expect, afterEach, vi } from 'vitest';

describe('DEFAULT_LSP_REQUEST_TIMEOUT_MS', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.OMC_LSP_TIMEOUT_MS;
  });

  async function importClientModule() {
    vi.resetModules();
    return import('../client.js');
  }

  async function importTimeout(): Promise<number> {
    const mod = await importClientModule();
    return mod.DEFAULT_LSP_REQUEST_TIMEOUT_MS;
  }

  it('should default to 15000 when env var is not set', async () => {
    delete process.env.OMC_LSP_TIMEOUT_MS;
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should use env var value when set to a valid number', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '30000';
    const timeout = await importTimeout();
    expect(timeout).toBe(30_000);
  });

  it('should trim surrounding whitespace from a valid timeout', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = ' 30000 \t';
    const timeout = await importTimeout();
    expect(timeout).toBe(30_000);
  });

  it('should fall back to 15000 for non-numeric env var', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = 'not-a-number';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should fall back to 15000 for zero', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '0';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should fall back to 15000 for negative values', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '-5000';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should fall back for integers outside the safe numeric range', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '9007199254740992';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should accept the maximum delay supported by Node timers', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '2147483647';
    const timeout = await importTimeout();
    expect(timeout).toBe(2_147_483_647);
  });

  it('should fall back when the timeout exceeds the Node timer limit', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '2147483648';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should read a scientific integer instead of stopping at the exponent', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '1e5';
    const timeout = await importTimeout();
    expect(timeout).toBe(100_000);
  });

  it('should ignore a fractional timeout instead of keeping the truncated prefix', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '8.9';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should ignore trailing junk instead of keeping the truncated prefix', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '12abc';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should ignore a numeric separator instead of keeping the digits before it', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '15_000';
    const timeout = await importTimeout();
    expect(timeout).toBe(15_000);
  });

  it('should keep non-initialize requests on the base timeout', async () => {
    const mod = await importClientModule();
    expect(mod.getLspRequestTimeout({}, 'hover')).toBe(15_000);
  });

  it('should use kotlin initialize timeout minimum when larger than default', async () => {
    const mod = await importClientModule();
    expect(mod.getLspRequestTimeout({ initializeTimeoutMs: 5 * 60 * 1000 }, 'initialize')).toBe(5 * 60 * 1000);
  });

  it('should preserve larger env-based timeouts over kotlin minimum', async () => {
    process.env.OMC_LSP_TIMEOUT_MS = '600000';
    const mod = await importClientModule();
    expect(mod.getLspRequestTimeout({ initializeTimeoutMs: 5 * 60 * 1000 }, 'initialize')).toBe(600000);
  });
});
