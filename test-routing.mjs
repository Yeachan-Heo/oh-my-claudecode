/**
 * Test script for model routing
 *
 * Tests the PROACTIVE routing approach where the orchestrator (Opus)
 * analyzes task complexity upfront and delegates to the right model.
 */

import {
  routeTask,
  getModelForTask,
  analyzeTaskComplexity,
  adaptPromptForTier,
  quickTierForAgent,
  explainRouting,
  extractAllSignals,
  calculateComplexityScore,
  TIER_MODELS,
} from './dist/features/model-routing/index.js';

console.log('=== Model Routing Test Suite ===\n');

// Test cases with expected tiers
const testCases = [
  // LOW tier - simple searches
  { prompt: 'Find all .ts files in src/', agent: 'explore', expectedTier: 'LOW' },
  { prompt: 'Where is the config file?', agent: 'explore', expectedTier: 'LOW' },
  { prompt: 'List all functions in utils.ts', agent: 'explore', expectedTier: 'LOW' },

  // MEDIUM tier - standard implementation
  { prompt: 'Add a new button component with hover state', agent: 'frontend-engineer', expectedTier: 'MEDIUM' },
  { prompt: 'Update the user list component to show email addresses', agent: 'sisyphus-junior', expectedTier: 'MEDIUM' },

  // HIGH tier - risky refactoring (detected via keywords)
  { prompt: 'Refactor the user service to use the new database schema and add migrations', agent: 'sisyphus-junior', expectedTier: 'HIGH' },

  // LOW tier - short or document-writer tasks
  { prompt: 'Write documentation for the API endpoints', agent: 'document-writer', expectedTier: 'LOW' },
  { prompt: 'Implement the user profile page', agent: 'sisyphus-junior', expectedTier: 'LOW' },

  // HIGH tier - complex tasks
  { prompt: 'Analyze the root cause of the authentication bug affecting production users', agent: 'oracle', expectedTier: 'HIGH' },
  { prompt: 'Design the architecture for a new microservices system with event sourcing', agent: 'oracle', expectedTier: 'HIGH' },
  { prompt: 'Refactor the entire API layer to use dependency injection pattern', agent: 'prometheus', expectedTier: 'HIGH' },
  { prompt: 'Debug the critical security vulnerability in the payment system', agent: 'oracle', expectedTier: 'HIGH' },
];

console.log('--- Test 1: Basic Routing ---\n');

let passed = 0;
let failed = 0;

for (const test of testCases) {
  const decision = routeTask({
    taskPrompt: test.prompt,
    agentType: test.agent,
  });

  const status = decision.tier === test.expectedTier ? '✓' : '✗';
  const color = decision.tier === test.expectedTier ? '\x1b[32m' : '\x1b[31m';

  console.log(`${color}${status}\x1b[0m [${decision.tier}] ${test.agent}: "${test.prompt.substring(0, 50)}..."`);
  console.log(`   Model: ${decision.model}`);
  console.log(`   Confidence: ${(decision.confidence * 100).toFixed(0)}%`);
  console.log(`   Reasons: ${decision.reasons.join(', ')}`);
  console.log('');

  if (decision.tier === test.expectedTier) {
    passed++;
  } else {
    failed++;
    console.log(`   Expected: ${test.expectedTier}, Got: ${decision.tier}`);
  }
}

console.log(`\n--- Results: ${passed}/${testCases.length} passed ---\n`);

console.log('--- Test 2: Agent Quick Tier Lookup ---\n');

const agents = ['oracle', 'prometheus', 'momus', 'explore', 'document-writer', 'frontend-engineer', 'sisyphus-junior'];
for (const agent of agents) {
  const tier = quickTierForAgent(agent);
  console.log(`  ${agent}: ${tier} → ${TIER_MODELS[tier]}`);
}

console.log('\n--- Test 3: Proactive Model Selection (getModelForTask) ---\n');

const modelTestCases = [
  // Worker agents - adaptive based on task
  { agent: 'sisyphus-junior', prompt: 'Fix this typo in the README', expectedModel: 'haiku' },
  { agent: 'sisyphus-junior', prompt: 'Refactor payment system with migration scripts for production data', expectedModel: 'opus' },

  // Oracle - adaptive: lookup → haiku, complex → opus
  { agent: 'oracle', prompt: 'Where is the auth middleware configured?', expectedModel: 'haiku' },
  { agent: 'oracle', prompt: 'Debug this race condition in the payment system', expectedModel: 'opus' },

  // Prometheus - adaptive: simple → haiku, strategic → opus
  { agent: 'prometheus', prompt: 'List the steps to add a button', expectedModel: 'haiku' },
  { agent: 'prometheus', prompt: 'Design the migration strategy for our monolith to microservices with risk analysis', expectedModel: 'opus' },

  // Explore - adaptive (not fixed to haiku anymore)
  { agent: 'explore', prompt: 'Find all .ts files', expectedModel: 'haiku' },

  // Orchestrator - ONLY fixed tier (always opus)
  { agent: 'orchestrator-sisyphus', prompt: 'Simple task', expectedModel: 'opus' },
];

console.log('Orchestrator proactively selects model based on task complexity:\n');

for (const test of modelTestCases) {
  const result = getModelForTask(test.agent, test.prompt);
  const status = result.model === test.expectedModel ? '✓' : '✗';
  const color = result.model === test.expectedModel ? '\x1b[32m' : '\x1b[31m';
  console.log(`${color}${status}\x1b[0m ${test.agent} + "${test.prompt.substring(0, 40)}..."`);
  console.log(`   → model: ${result.model} (${result.tier})`);
  console.log(`   → reason: ${result.reason}`);
  console.log('');
}

console.log('--- Test 4: Prompt Adaptation ---\n');

const samplePrompt = 'Implement user authentication with JWT tokens';

console.log('Original prompt:', samplePrompt);
console.log('\nAdapted for each tier:\n');

for (const tier of ['LOW', 'MEDIUM', 'HIGH']) {
  console.log(`=== ${tier} tier ===`);
  const adapted = adaptPromptForTier(samplePrompt, tier);
  console.log(adapted.substring(0, 300) + (adapted.length > 300 ? '...' : ''));
  console.log('');
}

console.log('--- Test 5: Signal Extraction ---\n');

const complexPrompt = `
  Analyze the production authentication system across multiple services.
  The bug affects user login, session management, and API authorization.
  We need to understand the root cause and design a fix that handles:
  1. Race conditions in token refresh
  2. Session invalidation across microservices
  3. Backwards compatibility with existing clients

  This is critical and urgent - users are being logged out randomly.
`;

console.log('Complex prompt signals:');
const signals = extractAllSignals(complexPrompt, 'oracle');
console.log(JSON.stringify(signals, null, 2));

const score = calculateComplexityScore(signals);
console.log(`\nComplexity score: ${score.toFixed(2)}`);

console.log('\n--- Test 6: Routing Explanation ---\n');

const explanation = explainRouting({
  taskPrompt: complexPrompt,
  agentType: 'oracle',
});
console.log(explanation);

console.log('\n--- Test 7: Complexity Analysis Helper ---\n');

const analysisPrompt = 'Refactor the payment processing module to support multiple payment providers and add migration scripts for existing transactions';
const analysis = analyzeTaskComplexity(analysisPrompt, 'sisyphus-junior');

console.log('Task:', analysisPrompt.substring(0, 60) + '...');
console.log('\nAnalysis Result:');
console.log(analysis.analysis);
console.log('\nKey Signals:');
console.log(`  - Word count: ${analysis.signals.wordCount}`);
console.log(`  - Architecture keywords: ${analysis.signals.hasArchitectureKeywords}`);
console.log(`  - Risk keywords: ${analysis.signals.hasRiskKeywords}`);
console.log(`  - Estimated subtasks: ${analysis.signals.estimatedSubtasks}`);
console.log(`  - Impact scope: ${analysis.signals.impactScope}`);

console.log('\n=== All Tests Complete ===');
console.log('\nSUMMARY: Routing is now PROACTIVE - orchestrator (Opus) analyzes');
console.log('complexity upfront and delegates with the appropriate model parameter.');
