/**
 * Manual tests for delegation categories
 *
 * Run with: npx tsx src/features/delegation-categories/test-categories.ts
 */

import {
  resolveCategory,
  isValidCategory,
  getAllCategories,
  getCategoryDescription,
  detectCategoryFromPrompt,
  getCategoryForTask,
  getCategoryTier,
  getCategoryTemperature,
  getCategoryThinkingBudget,
  getCategoryThinkingBudgetTokens,
  enhancePromptWithCategory,
  CATEGORY_CONFIGS,
} from './index.js';

console.log('=== Delegation Categories Test ===\n');

// Test 1: Resolve all categories
console.log('1. Testing resolveCategory():');
for (const category of getAllCategories()) {
  const resolved = resolveCategory(category);
  console.log(`  ${category}:`);
  console.log(`    tier: ${resolved.tier}`);
  console.log(`    temperature: ${resolved.temperature}`);
  console.log(`    thinkingBudget: ${resolved.thinkingBudget}`);
  console.log(`    description: ${resolved.description}`);
}
console.log();

// Test 2: isValidCategory
console.log('2. Testing isValidCategory():');
console.log(`  isValidCategory('ultrabrain'): ${isValidCategory('ultrabrain')}`);
console.log(`  isValidCategory('invalid'): ${isValidCategory('invalid')}`);
console.log();

// Test 3: getCategoryDescription
console.log('3. Testing getCategoryDescription():');
console.log(`  ultrabrain: ${getCategoryDescription('ultrabrain')}`);
console.log(`  quick: ${getCategoryDescription('quick')}`);
console.log();

// Test 4: detectCategoryFromPrompt
console.log('4. Testing detectCategoryFromPrompt():');
const testPrompts = [
  'Design a beautiful dashboard with responsive layout',
  'Debug this complex race condition in the system',
  'Find where the authentication function is defined',
  'Write comprehensive documentation for the API',
  'Come up with innovative solutions for this problem',
  'Simple task with no keywords',
];

for (const prompt of testPrompts) {
  const detected = detectCategoryFromPrompt(prompt);
  console.log(`  "${prompt}"`);
  console.log(`    -> ${detected || 'null'}`);
}
console.log();

// Test 5: getCategoryForTask
console.log('5. Testing getCategoryForTask():');

// Explicit tier
const explicitTier = getCategoryForTask({
  taskPrompt: 'Some task',
  explicitTier: 'LOW',
});
console.log(`  Explicit tier=LOW: ${explicitTier.category} (tier: ${explicitTier.tier})`);

// Explicit category
const explicitCategory = getCategoryForTask({
  taskPrompt: 'Some task',
  explicitCategory: 'ultrabrain',
});
console.log(`  Explicit category=ultrabrain: ${explicitCategory.category} (tier: ${explicitCategory.tier})`);

// Auto-detect
const autoDetect = getCategoryForTask({
  taskPrompt: 'Design a beautiful UI component with animations',
});
console.log(`  Auto-detect from prompt: ${autoDetect.category} (tier: ${autoDetect.tier})`);
console.log();

// Test 6: Tier extraction
console.log('6. Testing tier extraction:');
console.log(`  getCategoryTier('ultrabrain'): ${getCategoryTier('ultrabrain')}`);
console.log(`  getCategoryTier('quick'): ${getCategoryTier('quick')}`);
console.log(`  getCategoryTemperature('artistry'): ${getCategoryTemperature('artistry')}`);
console.log(`  getCategoryThinkingBudget('ultrabrain'): ${getCategoryThinkingBudget('ultrabrain')}`);
console.log(`  getCategoryThinkingBudgetTokens('ultrabrain'): ${getCategoryThinkingBudgetTokens('ultrabrain')}`);
console.log();

// Test 7: Prompt enhancement
console.log('7. Testing enhancePromptWithCategory():');
const basePrompt = 'Create a login form';
const enhanced = enhancePromptWithCategory(basePrompt, 'visual-engineering');
console.log(`  Base: ${basePrompt}`);
console.log(`  Enhanced: ${enhanced}`);
console.log();

// Test 8: Backward compatibility
console.log('8. Testing backward compatibility with ComplexityTier:');
console.log('  Categories map to tiers:');
for (const [category, config] of Object.entries(CATEGORY_CONFIGS)) {
  console.log(`    ${category} -> ${config.tier}`);
}
console.log();

console.log('=== All tests completed ===');
