/**
 * Top-level benchmark runner for all agent prompt evaluations.
 *
 * Runs each agent benchmark sequentially and optionally saves/compares baselines.
 *
 * Usage:
 *   npx tsx benchmarks/run-all.ts [options]
 *
 * Options:
 *   --save-baseline      Save results as a new baseline
 *   --compare            Compare current results against the latest baseline
 *   --agent <name>       Run only one agent benchmark (critic|code-reviewer|debugger|executor)
 *   --fixture <id>       Run a single fixture only (within the selected agent)
 *   --model <model>      Claude model to use (default: claude-opus-4-6)
 *   --dry-run            Validate pipeline without API calls
 */

import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// ============================================================
// Directory resolution
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BENCHMARKS_DIR = __dirname;
const BASELINES_DIR = join(BENCHMARKS_DIR, 'baselines');

// ============================================================
// CLI argument parsing
// ============================================================

interface RunAllArgs {
  saveBaseline: boolean;
  compare: boolean;
  agent: string | null;
  passthrough: string[];
}

function parseArgs(): RunAllArgs {
  const args = process.argv.slice(2);
  const result: RunAllArgs = {
    saveBaseline: false,
    compare: false,
    agent: null,
    passthrough: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--save-baseline':
        result.saveBaseline = true;
        break;
      case '--compare':
        result.compare = true;
        break;
      case '--agent':
        result.agent = args[++i];
        break;
      default:
        // Pass through to sub-runners
        result.passthrough.push(arg);
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          result.passthrough.push(args[++i]);
        }
        break;
    }
  }

  return result;
}

// ============================================================
// Agent benchmark definitions
// ============================================================

interface AgentBenchmark {
  name: string;
  dir: string;
  script: string;
}

const ALL_BENCHMARKS: AgentBenchmark[] = [
  {
    name: 'harsh-critic',
    dir: join(BENCHMARKS_DIR, 'harsh-critic'),
    script: join(BENCHMARKS_DIR, 'harsh-critic', 'run-benchmark.ts'),
  },
  {
    name: 'code-reviewer',
    dir: join(BENCHMARKS_DIR, 'code-reviewer'),
    script: join(BENCHMARKS_DIR, 'code-reviewer', 'run-benchmark.ts'),
  },
  {
    name: 'debugger',
    dir: join(BENCHMARKS_DIR, 'debugger'),
    script: join(BENCHMARKS_DIR, 'debugger', 'run-benchmark.ts'),
  },
  {
    name: 'executor',
    dir: join(BENCHMARKS_DIR, 'executor'),
    script: join(BENCHMARKS_DIR, 'executor', 'run-benchmark.ts'),
  },
];

// ============================================================
// Baseline management
// ============================================================

function getLatestBaseline(): string | null {
  if (!existsSync(BASELINES_DIR)) return null;

  const files = readdirSync(BASELINES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  return files.length > 0 ? join(BASELINES_DIR, files[0]) : null;
}

interface BaselineEntry {
  agent: string;
  compositeScore: number;
  truePositiveRate: number;
  falseNegativeRate: number;
  fixtureCount: number;
}

interface Baseline {
  timestamp: string;
  model: string;
  agents: BaselineEntry[];
}

function saveBaseline(results: Map<string, unknown>): void {
  if (!existsSync(BASELINES_DIR)) {
    mkdirSync(BASELINES_DIR, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const baselinePath = join(BASELINES_DIR, `${date}-benchmark.json`);

  const baseline: Baseline = {
    timestamp: new Date().toISOString(),
    model: 'claude-opus-4-6',
    agents: [],
  };

  for (const [agentName, resultData] of results) {
    const data = resultData as Record<string, unknown>;
    if (data && typeof data === 'object' && 'aggregateScores' in data) {
      const aggScores = data.aggregateScores as Record<string, Record<string, number>>;
      // Get the first agent's scores from the comparison report
      const firstAgentKey = Object.keys(aggScores)[0];
      if (firstAgentKey) {
        const scores = aggScores[firstAgentKey];
        baseline.agents.push({
          agent: agentName,
          compositeScore: scores.compositeScore ?? 0,
          truePositiveRate: scores.truePositiveRate ?? 0,
          falseNegativeRate: scores.falseNegativeRate ?? 0,
          fixtureCount: (data.results as unknown[])?.length ?? 0,
        });
      }
    }
  }

  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
  console.log(`\nBaseline saved: ${baselinePath}`);
}

function compareWithBaseline(
  results: Map<string, unknown>,
  baselinePath: string,
): void {
  const baseline: Baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));

  console.log('\n=== Baseline Comparison ===');
  console.log(`Baseline: ${baselinePath}`);
  console.log(`Baseline date: ${baseline.timestamp}\n`);

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const sign = (v: number) => (v >= 0 ? '+' : '') + pct(v);

  for (const entry of baseline.agents) {
    const currentData = results.get(entry.agent) as Record<string, unknown> | undefined;
    if (!currentData) {
      console.log(`  ${entry.agent}: [not run in current benchmark]`);
      continue;
    }

    const aggScores = currentData.aggregateScores as Record<string, Record<string, number>>;
    const firstAgentKey = Object.keys(aggScores)[0];
    if (!firstAgentKey) continue;

    const current = aggScores[firstAgentKey];
    const compositeDelta = (current.compositeScore ?? 0) - entry.compositeScore;
    const tpDelta = (current.truePositiveRate ?? 0) - entry.truePositiveRate;

    console.log(`  ${entry.agent}:`);
    console.log(`    Composite: ${pct(entry.compositeScore)} -> ${pct(current.compositeScore ?? 0)} (${sign(compositeDelta)})`);
    console.log(`    TP Rate:   ${pct(entry.truePositiveRate)} -> ${pct(current.truePositiveRate ?? 0)} (${sign(tpDelta)})`);

    const improved = compositeDelta > 0.01;
    const regressed = compositeDelta < -0.01;
    if (improved) console.log('    Status: IMPROVED');
    else if (regressed) console.log('    Status: REGRESSED');
    else console.log('    Status: STABLE');
    console.log('');
  }
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs();

  // Filter benchmarks
  const benchmarks = args.agent
    ? ALL_BENCHMARKS.filter((b) => b.name === args.agent)
    : ALL_BENCHMARKS;

  if (benchmarks.length === 0) {
    console.error(`Error: Unknown agent "${args.agent}". Available: ${ALL_BENCHMARKS.map((b) => b.name).join(', ')}`);
    process.exit(1);
  }

  console.log('=== Agent Prompt Benchmark Suite ===\n');
  console.log(`Running ${benchmarks.length} benchmark(s): ${benchmarks.map((b) => b.name).join(', ')}\n`);

  const allResults = new Map<string, unknown>();
  const passArgs = args.passthrough.join(' ');

  for (const benchmark of benchmarks) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Running: ${benchmark.name}`);
    console.log(`${'='.repeat(60)}\n`);

    if (!existsSync(benchmark.script)) {
      console.warn(`  Skipping ${benchmark.name}: script not found at ${benchmark.script}`);
      continue;
    }

    try {
      execSync(
        `npx tsx ${benchmark.script} ${passArgs}`,
        {
          stdio: 'inherit',
          cwd: resolve(BENCHMARKS_DIR, '..'),
          env: process.env,
        },
      );

      // Try to load the results
      const resultsPath = join(benchmark.dir, 'results', 'results.json');
      if (existsSync(resultsPath)) {
        const data = JSON.parse(readFileSync(resultsPath, 'utf-8'));
        allResults.set(benchmark.name, data);
      }
    } catch (err) {
      console.error(`\nBenchmark ${benchmark.name} failed:`, err);
      // Continue to the next benchmark
    }
  }

  // Baseline operations
  if (args.saveBaseline && allResults.size > 0) {
    saveBaseline(allResults);
  }

  if (args.compare) {
    const baselinePath = getLatestBaseline();
    if (baselinePath) {
      compareWithBaseline(allResults, baselinePath);
    } else {
      console.log('\nNo baseline found. Run with --save-baseline first.');
    }
  }

  console.log('\n=== All Benchmarks Complete ===\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
