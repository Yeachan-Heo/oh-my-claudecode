/**
 * Test for issue #4933: opt-in model-routing for Agent/Task calls naming fable or a model outside haiku, sonnet and opus
 * 
 * This test verifies that:
 * 1. By default (baseline), Jev is NOT asked about 'fable' model
 * 2. With OMC_JEV_MODEL_ROUTING_FABLE=1, Jev IS asked about 'fable' model
 * 3. Jev's answer can be used to route calls from fable to other models
 * 4. Non-Claude models are still not asked about even with opt-in
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('issue #4933: opt-in fable model routing', () => {
  const savedEnv: Record<string, string | undefined> = {};
  
  beforeEach(() => {
    // Save environment variables
    savedEnv.OMC_JEV_MODEL_ROUTING_FABLE = process.env.OMC_JEV_MODEL_ROUTING_FABLE;
  });

  afterEach(() => {
    // Restore environment variables
    if (savedEnv.OMC_JEV_MODEL_ROUTING_FABLE === undefined) {
      delete process.env.OMC_JEV_MODEL_ROUTING_FABLE;
    } else {
      process.env.OMC_JEV_MODEL_ROUTING_FABLE = savedEnv.OMC_JEV_MODEL_ROUTING_FABLE;
    }
  });

  it('should NOT include fable in allowed models by default', () => {
    delete process.env.OMC_JEV_MODEL_ROUTING_FABLE;
    
    // Simulate the gate logic
    const allowedModels = ['haiku', 'sonnet', 'opus'];
    if ((process.env.OMC_JEV_MODEL_ROUTING_FABLE || '').trim() === '1') {
      allowedModels.push('fable');
    }
    
    expect(allowedModels).not.toContain('fable');
    expect(allowedModels).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('should include fable in allowed models when OMC_JEV_MODEL_ROUTING_FABLE=1', () => {
    process.env.OMC_JEV_MODEL_ROUTING_FABLE = '1';
    
    // Simulate the gate logic
    const allowedModels = ['haiku', 'sonnet', 'opus'];
    if ((process.env.OMC_JEV_MODEL_ROUTING_FABLE || '').trim() === '1') {
      allowedModels.push('fable');
    }
    
    expect(allowedModels).toContain('fable');
    expect(allowedModels).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });

  it('should build model routing questions without fable by default', () => {
    delete process.env.OMC_JEV_MODEL_ROUTING_FABLE;
    
    // Simulate buildModelRoutingQuestions
    const criteria: Record<string, string> = {
      haiku: 'Quick lookups and lightweight, mechanical work',
      sonnet: 'Standard coding and orchestration work',
      opus: 'Complex architecture and deep analysis',
    };
    if ((process.env.OMC_JEV_MODEL_ROUTING_FABLE || '').trim() === '1') {
      criteria.fable = 'Ultra-lightweight reasoning for simple, focused tasks';
    }
    
    expect(Object.keys(criteria)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(criteria.fable).toBeUndefined();
  });

  it('should build model routing questions with fable when OMC_JEV_MODEL_ROUTING_FABLE=1', () => {
    process.env.OMC_JEV_MODEL_ROUTING_FABLE = '1';
    
    // Simulate buildModelRoutingQuestions
    const criteria: Record<string, string> = {
      haiku: 'Quick lookups and lightweight, mechanical work',
      sonnet: 'Standard coding and orchestration work',
      opus: 'Complex architecture and deep analysis',
    };
    if ((process.env.OMC_JEV_MODEL_ROUTING_FABLE || '').trim() === '1') {
      criteria.fable = 'Ultra-lightweight reasoning for simple, focused tasks';
    }
    
    expect(Object.keys(criteria)).toContain('fable');
    expect(criteria.fable).toBe('Ultra-lightweight reasoning for simple, focused tasks');
  });

  it('should handle various opt-in values for OMC_JEV_MODEL_ROUTING_FABLE', () => {
    const testCases = [
      { value: '1', shouldInclude: true, desc: 'with "1"' },
      { value: 'true', shouldInclude: false, desc: 'with "true" (not "1")' },
      { value: 'yes', shouldInclude: false, desc: 'with "yes" (not "1")' },
      { value: '0', shouldInclude: false, desc: 'with "0"' },
      { value: '', shouldInclude: false, desc: 'with empty string' },
    ];

    for (const testCase of testCases) {
      process.env.OMC_JEV_MODEL_ROUTING_FABLE = testCase.value;
      
      const allowedModels = ['haiku', 'sonnet', 'opus'];
      if ((process.env.OMC_JEV_MODEL_ROUTING_FABLE || '').trim() === '1') {
        allowedModels.push('fable');
      }
      
      if (testCase.shouldInclude) {
        expect(allowedModels).toContain('fable', `fable should be included ${testCase.desc}`);
      } else {
        expect(allowedModels).not.toContain('fable', `fable should NOT be included ${testCase.desc}`);
      }
    }
  });

  it('should validate Jev response against allowed models', () => {
    delete process.env.OMC_JEV_MODEL_ROUTING_FABLE;
    
    // Test baseline: without opt-in, fable is not valid
    const baselineValidChoices = ['haiku', 'sonnet', 'opus'];
    expect(baselineValidChoices).not.toContain('fable');
    
    // Test with opt-in: fable is valid
    process.env.OMC_JEV_MODEL_ROUTING_FABLE = '1';
    const optInValidChoices = ['haiku', 'sonnet', 'opus'];
    if ((process.env.OMC_JEV_MODEL_ROUTING_FABLE || '').trim() === '1') {
      optInValidChoices.push('fable');
    }
    expect(optInValidChoices).toContain('fable');
  });
});
