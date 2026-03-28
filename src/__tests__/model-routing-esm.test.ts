import { describe, it, expect } from 'vitest';
import { routeAndAdaptTask } from '../features/model-routing/index.js';

describe('model-routing ESM compatibility', () => {
  it('routeAndAdaptTask should work without require() (ESM-safe)', () => {
    // This test verifies BUG FIX: routeAndAdaptTask used require() calls
    // inside an ESM module, causing ReferenceError at runtime.
    // The fix replaces require() with already-imported ESM re-exports.
    const result = routeAndAdaptTask('Find the config file');

    expect(result).toBeDefined();
    expect(result.decision).toBeDefined();
    expect(result.decision.tier).toBeDefined();
    expect(typeof result.adaptedPrompt).toBe('string');
  });

  it('routeAndAdaptTask should handle optional parameters', () => {
    const result = routeAndAdaptTask('Complex architecture refactoring', 'architect', 2);

    expect(result).toBeDefined();
    expect(result.decision).toBeDefined();
    expect(result.decision.tier).toBeDefined();
    expect(typeof result.adaptedPrompt).toBe('string');
  });

  it('routeAndAdaptTask should return valid routing decision with tier', () => {
    const result = routeAndAdaptTask('Simple search task');

    expect(['LOW', 'MEDIUM', 'HIGH', 'EXPLICIT']).toContain(result.decision.tier);
  });
});
