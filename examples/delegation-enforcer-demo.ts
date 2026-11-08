/**
 * Delegation Enforcer Demo
 *
 * Demonstrates how the delegation enforcer automatically injects
 * model parameters for Task/Agent calls based on agent definitions.
 */

import {
  enforceModel,
  getModelForAgent,
  enforceModelInPreToolUse,
  type DelegationAgentInput
} from '../src/index.js';

console.log('=== Delegation Enforcer Demo ===\n');

// Example 1: Without explicit model - model gets auto-injected
console.log('Example 1: Task without explicit model');
console.log('--------------------------------------');

const taskWithoutModel: DelegationAgentInput = {
  description: 'Implement feature',
  prompt: 'Add error handling to the login function',
  subagent_type: 'oh-my-claudecode:executor'
};

console.log('Input:', JSON.stringify(taskWithoutModel, null, 2));

const result1 = enforceModel(taskWithoutModel);
console.log('\nOutput:', JSON.stringify(result1.modifiedInput, null, 2));
console.log('Model injected:', result1.injected);
console.log('Model used:', result1.model);
console.log('');

// Example 2: With explicit model - model is preserved
console.log('\nExample 2: Task with explicit model');
console.log('-----------------------------------');

const taskWithModel: DelegationAgentInput = {
  description: 'Quick lookup',
  prompt: 'Find the definition of the User interface',
  subagent_type: 'oh-my-claudecode:executor',
  model: 'haiku'
};

console.log('Input:', JSON.stringify(taskWithModel, null, 2));

const result2 = enforceModel(taskWithModel);
console.log('\nOutput:', JSON.stringify(result2.modifiedInput, null, 2));
console.log('Model injected:', result2.injected);
console.log('Model used:', result2.model);
console.log('');

// Example 3: Different agent tiers use different models
console.log('\nExample 3: Different agent tiers');
console.log('-------------------------------');

const agents = [
  'executor-low',
  'executor',
  'executor-high',
  'architect-low',
  'architect',
  'designer'
];

for (const agent of agents) {
  const model = getModelForAgent(agent);
  console.log(`${agent.padEnd(20)} → ${model}`);
}
console.log('');

// Example 4: Integration with pre-tool-use hook
console.log('\nExample 4: Pre-tool-use hook integration');
console.log('---------------------------------------');

const hookResult = enforceModelInPreToolUse('Task', taskWithoutModel);
console.log('Hook continues:', hookResult.modifiedInput !== undefined);
console.log('Modified input has model:', 'model' in (hookResult.modifiedInput as object));
console.log('Model value:', (hookResult.modifiedInput as { model?: string }).model);
console.log('');

// Example 5: Debug mode warning
console.log('\nExample 5: Debug mode (OMC_DEBUG=true)');
console.log('-------------------------------------');
console.log('Setting OMC_DEBUG=true to see warnings...\n');

process.env.OMC_DEBUG = 'true';

const result3 = enforceModel({
  description: 'Test',
  prompt: 'Test task',
  subagent_type: 'architect'
});

console.log('\nWarning message:', result3.warning);
console.log('Model injected:', result3.model);

// Clean up
delete process.env.OMC_DEBUG;

console.log('\n=== Demo Complete ===');
console.log('\nKey takeaways:');
console.log('1. Model parameter is auto-injected when not specified');
console.log('2. Explicit models are always preserved');
console.log('3. Each agent tier has its own default model');
console.log('4. Debug warnings only shown when OMC_DEBUG=true');
console.log('5. Works seamlessly with pre-tool-use hooks');
