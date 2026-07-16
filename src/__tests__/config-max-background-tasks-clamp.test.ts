/**
 * Tests for OMC_MAX_BACKGROUND_TASKS env override clamping.
 * The config schema enforces a 1-50 range; the env path must apply
 * the same bounds instead of passing raw values through.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvConfig } from '../config/loader.js';

describe('OMC_MAX_BACKGROUND_TASKS env var clamping', () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env.OMC_MAX_BACKGROUND_TASKS;
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.OMC_MAX_BACKGROUND_TASKS;
    } else {
      process.env.OMC_MAX_BACKGROUND_TASKS = originalValue;
    }
  });

  it('passes in-range values through unchanged', () => {
    process.env.OMC_MAX_BACKGROUND_TASKS = '10';
    const config = loadEnvConfig();
    expect(config.permissions?.maxBackgroundTasks).toBe(10);
  });

  it('clamps values above 50 down to 50', () => {
    process.env.OMC_MAX_BACKGROUND_TASKS = '500';
    const config = loadEnvConfig();
    expect(config.permissions?.maxBackgroundTasks).toBe(50);
  });

  it('clamps values below 1 up to 1', () => {
    process.env.OMC_MAX_BACKGROUND_TASKS = '0';
    const config = loadEnvConfig();
    expect(config.permissions?.maxBackgroundTasks).toBe(1);
  });

  it('clamps negative values up to 1', () => {
    process.env.OMC_MAX_BACKGROUND_TASKS = '-3';
    const config = loadEnvConfig();
    expect(config.permissions?.maxBackgroundTasks).toBe(1);
  });

  it('does not set maxBackgroundTasks for non-numeric values', () => {
    process.env.OMC_MAX_BACKGROUND_TASKS = 'not-a-number';
    const config = loadEnvConfig();
    expect(config.permissions?.maxBackgroundTasks).toBeUndefined();
  });

  it('does not set maxBackgroundTasks when env var is not defined', () => {
    delete process.env.OMC_MAX_BACKGROUND_TASKS;
    const config = loadEnvConfig();
    expect(config.permissions?.maxBackgroundTasks).toBeUndefined();
  });
});
