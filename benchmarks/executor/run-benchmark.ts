/**
 * Benchmark runner for executor agent evaluation.
 *
 * Compares the new merged executor (which absorbed deep-executor)
 * against the old deep-executor prompt to measure implementation quality.
 *
 * Usage:
 *   npx tsx benchmarks/executor/run-benchmark.ts [options]
 *
 * Options:
 *   --agent <name>       Run a single agent variant only
 *   --fixture <id>       Run a single fixture only
 *   --output-dir <path>  Where to write results
 *   --model <model>      Claude model to use (default: claude-opus-4-6)
 *   --dry-run            Validate pipeline without API calls
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  parseCliArgs,
  loadFixtures,
  loadAgentPrompt,
  runBenchmark,
  printSummaryTable,
  writeReports,
} from '../shared/runner.ts';
import { parseGenericOutput } from '../shared/parser.ts';
import type { ParsedAgentOutput } from '../shared/types.ts';

// ============================================================
// Directory resolution
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BENCHMARK_DIR = __dirname;
const REPO_ROOT = resolve(__dirname, '..', '..');

// ============================================================
// Agent configurations
// ============================================================

const AGENT_NEW = 'executor';
const AGENT_OLD = 'deep-executor';

function buildUserMessage(fixtureContent: string): string {
  return `Implement the following task. Describe your approach, the files you would modify, and the changes you would make:\n\n${fixtureContent}`;
}

// ============================================================
// Parser
// ============================================================

function parseOutput(rawOutput: string, _agentType: string): ParsedAgentOutput {
  return parseGenericOutput(rawOutput);
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(
    [AGENT_NEW, AGENT_OLD],
    join(BENCHMARK_DIR, 'results'),
  );

  // Load agent prompts
  console.log('Loading agent prompts...');
  const agents = cliArgs.agents.map((agentType) => ({
    agentType,
    systemPrompt: loadAgentPrompt(agentType, BENCHMARK_DIR, REPO_ROOT),
    userMessageTemplate: buildUserMessage,
  }));

  // Load fixtures
  console.log('Loading fixtures...');
  const fixtures = loadFixtures(BENCHMARK_DIR, cliArgs.fixture);
  console.log(`  ${fixtures.length} fixture(s) found: ${fixtures.map((f) => f.id).join(', ')}`);

  // Run benchmark
  const results = await runBenchmark({
    benchmarkDir: BENCHMARK_DIR,
    agents,
    fixtures,
    groundTruthDir: join(BENCHMARK_DIR, 'ground-truth'),
    parseFn: parseOutput,
    cliArgs,
  });

  if (results.length === 0) return; // dry-run

  // Print results
  printSummaryTable(results, cliArgs.agents);

  // Write reports
  console.log('\nGenerating reports...');
  writeReports(
    cliArgs.outputDir,
    results,
    cliArgs.agents[0],
    cliArgs.agents[1] ?? cliArgs.agents[0],
    cliArgs.model,
  );

  console.log('\nBenchmark complete.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
