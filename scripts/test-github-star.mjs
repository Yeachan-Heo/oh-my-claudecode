#!/usr/bin/env node
/**
 * GitHub Star Integration Test
 *
 * Tests the GitHub star functionality with real gh API calls.
 * Run with: node scripts/test-github-star.mjs
 */

import { execSync } from 'child_process';

// Import from built files
const {
  isGhCliAvailable,
  isRepoStarred,
  starRepository,
  autoStarRepository,
} = await import('../dist/hooks/setup/github-star.js');

const TEST_REPO = 'Yeachan-Heo/oh-my-claudecode';

console.log('🧪 GitHub Star Integration Test\n');

// Test 1: Check if gh CLI is available
console.log('Test 1: Check gh CLI availability');
const ghAvailable = isGhCliAvailable();
console.log(`  Result: ${ghAvailable ? '✅ gh CLI available' : '❌ gh CLI not available'}`);

if (!ghAvailable) {
  console.log('\n⚠️  gh CLI is not available. Skipping API tests.');
  console.log('   Install gh CLI: https://cli.github.com/');
  process.exit(0);
}

// Test 2: Check star status
console.log('\nTest 2: Check star status');
try {
  const isStarred = isRepoStarred(TEST_REPO);
  console.log(`  Result: ${isStarred ? '⭐ Already starred' : '☆ Not starred yet'}`);
} catch (error) {
  console.log(`  Error: ${error.message}`);
}

// Test 3: Auto-star repository
console.log('\nTest 3: Auto-star repository');
try {
  const result = autoStarRepository({ repo: TEST_REPO });
  console.log(`  Starred: ${result.starred}`);
  console.log(`  Action: ${result.action}`);
  console.log(`  Message: ${result.message}`);

  if (result.action === 'newly_starred') {
    console.log('\n  ✅ Successfully starred the repository!');
  } else if (result.action === 'already_starred') {
    console.log('\n  ℹ️  Repository was already starred');
  }
} catch (error) {
  console.log(`  Error: ${error.message}`);
}

// Test 4: Verify star after operation
console.log('\nTest 4: Verify star status after operation');
try {
  const isStarredNow = isRepoStarred(TEST_REPO);
  console.log(`  Result: ${isStarredNow ? '✅ Confirmed starred' : '❌ Not starred'}`);

  if (isStarredNow) {
    console.log('\n🎉 All tests passed! Repository is starred.');
  }
} catch (error) {
  console.log(`  Error: ${error.message}`);
}

// Test 5: Test with mock function
console.log('\nTest 5: Test with mock exec function');
let callCount = 0;
const mockExec = (command) => {
  callCount++;
  console.log(`  Mock exec call ${callCount}: ${command}`);

  // First call: gh --version (success)
  if (callCount === 1) return Buffer.from('gh version 2.0.0');

  // Second call: gh api user/starred/... (fail = not starred)
  if (callCount === 2) throw new Error('not starred');

  // Third call: gh api --method PUT (success = starred)
  return Buffer.from('');
};

const mockResult = autoStarRepository({
  repo: 'test/repo',
  execFn: mockExec
});

console.log(`  Mock result: ${mockResult.action}`);
console.log(`  Mock calls: ${callCount}`);
console.log(`  Expected: ${mockResult.action === 'newly_starred' && callCount === 3 ? '✅ Pass' : '❌ Fail'}`);

console.log('\n✅ All integration tests completed!\n');
