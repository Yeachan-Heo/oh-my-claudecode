/**
 * Test for fix: propagate fallback mode to detached resolver
 * Ensures spawnMode is passed in request JSON so detached resolver
 * knows whether to operate in fallback (shadow) or active mode.
 */
/* global process */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const jevResolvePath = join(root, 'scripts', 'jev-resolve.mjs');
const jevResolveModule = await import(jevResolvePath);

describe('jev-shadow: spawnMode propagation to resolver', () => {
  beforeEach(() => {
    // Reset environment for each test
    delete process.env.OMC_JEV_BREAKER;
    delete process.env.OMC_JEV_PLAN_MODE;
    delete process.env.OMC_JEV_MODE_ALL;
    delete process.env.OMC_JEV_ACTIVATE_POINTS;
  });

  it('should use spawnMode from request when provided', async () => {
    // The fix ensures that when recordJevShadow creates a request
    // for a detached resolver, it includes spawnMode so the resolver
    // knows which mode was forced (e.g., 'shadow' due to open breaker).
    // Without the fix, detached resolver would derive mode from env only.

    const testPoint = 'test-point';

    // Create a request with spawnMode set to 'off'
    // This lets us test without needing mocked network or breaker
    const request = {
      point: testPoint,
      state: { test: 'state' },
      questions: { q1: { type: 'choice', criteria: { a: 'A', b: 'B' } } },
      heuristic: 'fallback',
      permissionMode: 'auto',
      spawnMode: 'off', // This should be respected
    };

    const result = await jevResolveModule.resolveRequest(request);

    // Verify that spawnMode from request is used (mode is 'off')
    expect(result.mode).toBe('off');
  });

  it('should fall back to env config when spawnMode is undefined', async () => {
    // Backward compatibility: if spawnMode is not provided in request,
    // the resolver should derive mode from environment as before.

    const testPoint = 'test-point';

    // Set environment to 'off' mode
    process.env.OMC_JEV = 'off';

    const request = {
      point: testPoint,
      state: { test: 'state' },
      questions: { q1: { type: 'choice', criteria: { a: 'A', b: 'B' } } },
      heuristic: 'fallback',
      permissionMode: 'auto',
      // spawnMode is undefined
    };

    const result = await jevResolveModule.resolveRequest(request);

    // Mode should come from env: 'off'
    expect(result.mode).toBe('off');
  });

  it('should prefer spawnMode over environment when both are set', async () => {
    // spawnMode from request takes precedence over environment config.
    // This ensures the caller's intent (fallback mode due to breaker)
    // is respected even if environment says something different.

    const testPoint = 'test-point';

    // Set environment to 'active'
    process.env.OMC_JEV = 'all:active';
    process.env.TYPESAFE_API_KEY = 'test-key';

    // But request specifies 'off' mode
    const request = {
      point: testPoint,
      state: { test: 'state' },
      questions: { q1: { type: 'choice', criteria: { a: 'A', b: 'B' } } },
      heuristic: 'fallback',
      permissionMode: 'auto',
      spawnMode: 'off', // Takes precedence
    };

    const result = await jevResolveModule.resolveRequest(request);

    // Mode should be 'off' (from spawnMode), not 'active' (from env)
    expect(result.mode).toBe('off');
  });
});
