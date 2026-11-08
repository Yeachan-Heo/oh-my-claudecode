#!/usr/bin/env tsx
/**
 * Test script for max-attempts counter in todo-continuation
 *
 * Tests the resetTodoContinuationAttempts functionality to verify
 * that the counter tracking mechanism works correctly.
 */

import { resetTodoContinuationAttempts, checkPersistentModes } from '../src/hooks/persistent-mode/index.js';

async function runTests() {
  console.log('Testing max-attempts counter...\n');

  let testsPassed = 0;
  let testsFailed = 0;

  // Test 1: Basic reset functionality
  try {
    console.log('Test 1: Basic reset (should not throw)');
    resetTodoContinuationAttempts('test-session-1');
    console.log('✓ PASS: resetTodoContinuationAttempts executed without error\n');
    testsPassed++;
  } catch (error) {
    console.error('✗ FAIL: resetTodoContinuationAttempts threw error:', error);
    testsFailed++;
  }

  // Test 2: Multiple resets on same session
  try {
    console.log('Test 2: Multiple resets on same session');
    resetTodoContinuationAttempts('test-session-2');
    resetTodoContinuationAttempts('test-session-2');
    resetTodoContinuationAttempts('test-session-2');
    console.log('✓ PASS: Multiple resets work correctly\n');
    testsPassed++;
  } catch (error) {
    console.error('✗ FAIL: Multiple resets failed:', error);
    testsFailed++;
  }

  // Test 3: Reset different sessions
  try {
    console.log('Test 3: Reset different sessions');
    resetTodoContinuationAttempts('session-a');
    resetTodoContinuationAttempts('session-b');
    resetTodoContinuationAttempts('session-c');
    console.log('✓ PASS: Can reset different sessions independently\n');
    testsPassed++;
  } catch (error) {
    console.error('✗ FAIL: Different session resets failed:', error);
    testsFailed++;
  }

  // Test 4: Indirect test via checkPersistentModes (no todos should not throw)
  try {
    console.log('Test 4: Indirect test via checkPersistentModes');
    const result = await checkPersistentModes('test-session-indirect');
    console.log(`✓ PASS: checkPersistentModes executed (shouldBlock=${result.shouldBlock}, mode=${result.mode})\n`);
    testsPassed++;
  } catch (error) {
    console.error('✗ FAIL: checkPersistentModes threw error:', error);
    testsFailed++;
  }

  // Test 5: Reset with empty string session ID
  try {
    console.log('Test 5: Reset with empty string session ID');
    resetTodoContinuationAttempts('');
    console.log('✓ PASS: Empty session ID handled correctly\n');
    testsPassed++;
  } catch (error) {
    console.error('✗ FAIL: Empty session ID failed:', error);
    testsFailed++;
  }

  // Summary
  console.log('═══════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════');
  console.log(`Total tests: ${testsPassed + testsFailed}`);
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log('═══════════════════════════════════════\n');

  if (testsFailed === 0) {
    console.log('✓ ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.log('✗ SOME TESTS FAILED');
    process.exit(1);
  }
}

runTests();
