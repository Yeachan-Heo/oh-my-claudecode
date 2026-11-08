#!/usr/bin/env tsx
/**
 * Integration test for notepad auto-capture functionality
 *
 * Tests:
 * - Notepad initialization
 * - Working memory entries
 * - Priority context
 * - Context formatting
 * - Entry pruning
 * - Remember tag processing
 */

import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Import notepad functions
import {
  initNotepad,
  addWorkingMemoryEntry,
  setPriorityContext,
  getPriorityContext,
  getWorkingMemory,
  pruneOldEntries,
  formatNotepadContext,
  getNotepadStats,
  getNotepadPath,
  DEFAULT_CONFIG
} from '../dist/hooks/notepad/index.js';

// Import remember tag processing
import { processOrchestratorPostTool } from '../dist/hooks/omc-orchestrator/index.js';

// ============================================================================
// Test Infrastructure
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  process.stdout.write(`\n🧪 ${name}... `);
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => {
          results.push({ name, passed: true });
          console.log('✅ PASS');
        })
        .catch((error) => {
          results.push({
            name,
            passed: false,
            error: error instanceof Error ? error.message : String(error)
          });
          console.log('❌ FAIL');
          console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        });
    } else {
      results.push({ name, passed: true });
      console.log('✅ PASS');
    }
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    });
    console.log('❌ FAIL');
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
    );
  }
}

function assertContains(text: string, substring: string, message?: string): void {
  if (!text.includes(substring)) {
    throw new Error(
      message || `Expected text to contain "${substring}" but it didn't.\nText: ${text}`
    );
  }
}

function assertNotNull<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || 'Expected value to not be null/undefined');
  }
}

// ============================================================================
// Setup and Teardown
// ============================================================================

let testDir: string;

function setup(): void {
  testDir = join(tmpdir(), `notepad-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  console.log(`\n📁 Test directory: ${testDir}`);
}

function teardown(): void {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
    console.log(`\n🧹 Cleaned up test directory`);
  }
}

// ============================================================================
// Test Cases
// ============================================================================

function testInitialization(): void {
  const success = initNotepad(testDir);
  assert(success, 'initNotepad should return true');

  const notepadPath = getNotepadPath(testDir);
  assert(existsSync(notepadPath), 'notepad.md should exist after initialization');

  const content = readFileSync(notepadPath, 'utf-8');
  assertContains(content, '# Notepad', 'should contain header');
  assertContains(content, '## Priority Context', 'should contain Priority Context section');
  assertContains(content, '## Working Memory', 'should contain Working Memory section');
  assertContains(content, '## MANUAL', 'should contain MANUAL section');
}

function testWorkingMemoryEntry(): void {
  initNotepad(testDir);

  const success = addWorkingMemoryEntry(testDir, 'Test discovery: This is a test entry');
  assert(success, 'addWorkingMemoryEntry should return true');

  const workingMemory = getWorkingMemory(testDir);
  assertNotNull(workingMemory, 'working memory should not be null');
  assertContains(workingMemory, 'Test discovery', 'should contain the added entry');
  assertContains(workingMemory, '###', 'should contain timestamp header');
}

function testMultipleWorkingMemoryEntries(): void {
  const localDir = join(tmpdir(), `notepad-test-multi-${Date.now()}`);
  mkdirSync(localDir, { recursive: true });

  initNotepad(localDir);

  addWorkingMemoryEntry(localDir, 'First entry');
  addWorkingMemoryEntry(localDir, 'Second entry');
  addWorkingMemoryEntry(localDir, 'Third entry');

  const workingMemory = getWorkingMemory(localDir);
  assertNotNull(workingMemory, 'working memory should not be null');
  assertContains(workingMemory, 'First entry', 'should contain first entry');
  assertContains(workingMemory, 'Second entry', 'should contain second entry');
  assertContains(workingMemory, 'Third entry', 'should contain third entry');

  // Verify entries are separated
  const entryCount = (workingMemory.match(/###/g) || []).length;
  assertEquals(entryCount, 3, 'should have 3 timestamp headers');

  rmSync(localDir, { recursive: true, force: true });
}

function testPriorityContext(): void {
  initNotepad(testDir);

  const content = 'CRITICAL: Auth system requires JWT tokens with 15-min expiry';
  const result = setPriorityContext(testDir, content);
  assert(result.success, 'setPriorityContext should succeed');
  assert(!result.warning, 'should not have warning for short content');

  const retrieved = getPriorityContext(testDir);
  assertNotNull(retrieved, 'priority context should not be null');
  assertEquals(retrieved, content, 'retrieved content should match original');
}

function testPriorityContextOversize(): void {
  initNotepad(testDir);

  const longContent = 'x'.repeat(600); // Over 500 char limit
  const result = setPriorityContext(testDir, longContent);
  assert(result.success, 'setPriorityContext should still succeed');
  assert(result.warning !== undefined, 'should have warning for oversized content');
  assertContains(result.warning!, 'exceeds', 'warning should mention exceeding limit');
}

function testPriorityContextReplacement(): void {
  initNotepad(testDir);

  setPriorityContext(testDir, 'First priority');
  const first = getPriorityContext(testDir);
  assertEquals(first, 'First priority', 'should store first priority');

  setPriorityContext(testDir, 'Second priority');
  const second = getPriorityContext(testDir);
  assertEquals(second, 'Second priority', 'should replace with second priority');
  assertNotNull(second, 'second priority should not be null');
  assert(!second.includes('First priority'), 'should not contain first priority');
}

function testFormatNotepadContext(): void {
  initNotepad(testDir);
  setPriorityContext(testDir, 'Test priority content');

  const formatted = formatNotepadContext(testDir);
  assertNotNull(formatted, 'formatted context should not be null');
  assertContains(formatted, '<notepad-priority>', 'should have opening tag');
  assertContains(formatted, '</notepad-priority>', 'should have closing tag');
  assertContains(formatted, 'Test priority content', 'should contain priority content');
  assertContains(formatted, '## Priority Context', 'should contain section header');
}

function testFormatNotepadContextEmpty(): void {
  const localDir = join(tmpdir(), `notepad-test-empty-${Date.now()}`);
  mkdirSync(localDir, { recursive: true });

  initNotepad(localDir);
  // Don't set any priority context

  const formatted = formatNotepadContext(localDir);
  assertEquals(formatted, null, 'should return null when no priority context');

  rmSync(localDir, { recursive: true, force: true });
}

function testGetNotepadStats(): void {
  const localDir = join(tmpdir(), `notepad-test-stats-${Date.now()}`);
  mkdirSync(localDir, { recursive: true });

  initNotepad(localDir);
  addWorkingMemoryEntry(localDir, 'Entry 1');
  addWorkingMemoryEntry(localDir, 'Entry 2');
  setPriorityContext(localDir, 'Priority info');

  const stats = getNotepadStats(localDir);
  assert(stats.exists, 'notepad should exist');
  assert(stats.totalSize > 0, 'should have non-zero total size');
  assert(stats.prioritySize > 0, 'should have non-zero priority size');
  assertEquals(stats.workingMemoryEntries, 2, 'should have 2 working memory entries');
  assertNotNull(stats.oldestEntry, 'should have oldest entry timestamp');

  rmSync(localDir, { recursive: true, force: true });
}

function testPruningOldEntries(): void {
  const localDir = join(tmpdir(), `notepad-test-prune-${Date.now()}`);
  mkdirSync(localDir, { recursive: true });

  initNotepad(localDir);

  // Add entries with manipulated timestamps
  const notepadPath = getNotepadPath(localDir);
  let content = readFileSync(notepadPath, 'utf-8');

  // Manually insert entries with old dates
  const oldDate1 = new Date();
  oldDate1.setDate(oldDate1.getDate() - 10); // 10 days ago
  const oldDate2 = new Date();
  oldDate2.setDate(oldDate2.getDate() - 8); // 8 days ago
  const recentDate = new Date();
  recentDate.setDate(recentDate.getDate() - 2); // 2 days ago

  const formatDate = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

  const oldEntry1 = `### ${formatDate(oldDate1)}\nOld entry 1\n`;
  const oldEntry2 = `### ${formatDate(oldDate2)}\nOld entry 2\n`;
  const recentEntry = `### ${formatDate(recentDate)}\nRecent entry\n`;

  // Insert into Working Memory section
  content = content.replace(
    /## Working Memory\n<!-- Session notes\. Auto-pruned after 7 days\. -->\n/,
    `## Working Memory\n<!-- Session notes. Auto-pruned after 7 days. -->\n${oldEntry1}\n${oldEntry2}\n${recentEntry}\n`
  );
  writeFileSync(notepadPath, content);

  // Verify 3 entries before pruning
  const statsBefore = getNotepadStats(localDir);
  assertEquals(statsBefore.workingMemoryEntries, 3, 'should have 3 entries before pruning');

  // Prune entries older than 7 days
  const pruneResult = pruneOldEntries(localDir, 7);
  assertEquals(pruneResult.pruned, 2, 'should prune 2 old entries');
  assertEquals(pruneResult.remaining, 1, 'should have 1 remaining entry');

  // Verify only recent entry remains
  const workingMemory = getWorkingMemory(localDir);
  assertNotNull(workingMemory, 'working memory should not be null');
  assertContains(workingMemory, 'Recent entry', 'should contain recent entry');
  assert(!workingMemory.includes('Old entry 1'), 'should not contain old entry 1');
  assert(!workingMemory.includes('Old entry 2'), 'should not contain old entry 2');

  rmSync(localDir, { recursive: true, force: true });
}

function testRememberTagProcessing(): void {
  initNotepad(testDir);

  // Simulate agent output with <remember> tags
  const agentOutput = `
Here are my findings:

<remember>
Discovered that the API uses rate limiting of 100 req/min
</remember>

Some more text here.

<remember priority>
CRITICAL: Authentication tokens expire after 15 minutes
</remember>

Done!
`;

  // Process the output (simulating post-tool hook)
  processOrchestratorPostTool(
    {
      toolName: 'Task',
      toolInput: {},
      directory: testDir
    },
    agentOutput
  );

  // Verify priority context was captured
  const priority = getPriorityContext(testDir);
  assertNotNull(priority, 'priority context should be captured');
  assertContains(priority, 'CRITICAL', 'should contain priority tag content');
  assertContains(priority, '15 minutes', 'should contain specific priority detail');

  // Verify working memory was captured
  const workingMemory = getWorkingMemory(testDir);
  assertNotNull(workingMemory, 'working memory should be captured');
  assertContains(workingMemory, 'rate limiting', 'should contain working memory content');
  assertContains(workingMemory, '100 req/min', 'should contain specific detail');
}

function testRememberTagWithMultipleMatches(): void {
  const localDir = join(tmpdir(), `notepad-test-multi-remember-${Date.now()}`);
  mkdirSync(localDir, { recursive: true });

  initNotepad(localDir);

  const agentOutput = `
<remember>First discovery about authentication</remember>
<remember>Second discovery about caching</remember>
<remember>Third discovery about error handling</remember>
`;

  processOrchestratorPostTool(
    {
      toolName: 'Task',
      toolInput: {},
      directory: localDir
    },
    agentOutput
  );

  const workingMemory = getWorkingMemory(localDir);
  assertNotNull(workingMemory, 'working memory should not be null');
  assertContains(workingMemory, 'authentication', 'should contain first discovery');
  assertContains(workingMemory, 'caching', 'should contain second discovery');
  assertContains(workingMemory, 'error handling', 'should contain third discovery');

  // Verify 3 separate entries
  const entryCount = (workingMemory.match(/###/g) || []).length;
  assertEquals(entryCount, 3, 'should have 3 separate timestamped entries');

  rmSync(localDir, { recursive: true, force: true });
}

function testRememberTagIgnoresNonTaskTools(): void {
  const localDir = join(tmpdir(), `notepad-test-non-task-${Date.now()}`);
  mkdirSync(localDir, { recursive: true });

  initNotepad(localDir);

  const agentOutput = `
<remember>This should be ignored</remember>
`;

  // Process with non-Task tool
  processOrchestratorPostTool(
    {
      toolName: 'Read',
      toolInput: {},
      directory: localDir
    },
    agentOutput
  );

  const workingMemory = getWorkingMemory(localDir);
  // Should be null or empty since notepad was just initialized and no Task tool was used
  const isEmpty = workingMemory === null || workingMemory.trim() === '';
  assert(isEmpty, 'should not capture remember tags from non-Task tools');

  rmSync(localDir, { recursive: true, force: true });
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runTests(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  🧪 NOTEPAD INTEGRATION TEST SUITE');
  console.log('═══════════════════════════════════════════════════════════');

  setup();

  try {
    // Basic operations
    test('Notepad initialization', testInitialization);
    test('Add working memory entry', testWorkingMemoryEntry);
    test('Add multiple working memory entries', testMultipleWorkingMemoryEntries);

    // Priority context
    test('Set priority context', testPriorityContext);
    test('Priority context oversize warning', testPriorityContextOversize);
    test('Priority context replacement', testPriorityContextReplacement);

    // Formatting
    test('Format notepad context for injection', testFormatNotepadContext);
    test('Format empty notepad context', testFormatNotepadContextEmpty);

    // Stats and info
    test('Get notepad stats', testGetNotepadStats);

    // Pruning
    test('Prune old entries', testPruningOldEntries);

    // Remember tags
    test('Process <remember> tags', testRememberTagProcessing);
    test('Process multiple <remember> tags', testRememberTagWithMultipleMatches);
    test('Ignore <remember> tags from non-Task tools', testRememberTagIgnoresNonTaskTools);

    // Wait a bit for any async tests
    await new Promise(resolve => setTimeout(resolve, 100));

  } finally {
    teardown();
  }

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  📊 TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`\n  Total:  ${total}`);
  console.log(`  ✅ Pass:  ${passed}`);
  console.log(`  ❌ Fail:  ${failed}`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`    - ${r.name}`);
      if (r.error) {
        console.log(`      ${r.error}`);
      }
    });
  }

  console.log('\n═══════════════════════════════════════════════════════════\n');

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch((error) => {
  console.error('\n❌ Test runner failed:', error);
  process.exit(1);
});
