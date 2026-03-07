/**
 * Benchmark runner for harsh-critic vs critic agent evaluation.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx benchmarks/harsh-critic/run-benchmark.ts [options]
 *
 * Options:
 *   --agent harsh-critic|critic|both   Which agent(s) to run (default: both)
 *   --fixture <fixture-id>             Run a single fixture only
 *   --output-dir <path>                Where to write results (default: benchmarks/harsh-critic/results)
 *   --model <model>                    Claude model to use (default: claude-opus-4-6)
 *   --dry-run                          Load fixtures and ground truth but skip API calls
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { AgentType, FixtureResult, GroundTruth } from './scoring/types.ts';
import { parseAgentOutput } from './scoring/parser.ts';
import { scoreFixture, matchFindings } from './scoring/scorer.ts';
import { generateJsonReport, generateMarkdownReport } from './scoring/reporter.ts';

// ============================================================
// Directory resolution
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BENCHMARK_DIR = __dirname;
const REPO_ROOT = resolve(__dirname, '..', '..');

// ============================================================
// CLI argument parsing
// ============================================================

interface CliArgs {
  agent: 'harsh-critic' | 'critic' | 'both';
  fixture: string | null;
  outputDir: string;
  model: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    agent: 'both',
    fixture: null,
    outputDir: join(BENCHMARK_DIR, 'results'),
    model: 'claude-opus-4-6',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--agent': {
        const val = args[++i];
        if (val !== 'harsh-critic' && val !== 'critic' && val !== 'both') {
          console.error(`Error: --agent must be harsh-critic, critic, or both (got "${val}")`);
          process.exit(1);
        }
        result.agent = val;
        break;
      }
      case '--fixture':
        result.fixture = args[++i];
        break;
      case '--output-dir':
        result.outputDir = args[++i];
        break;
      case '--model':
        result.model = args[++i];
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return result;
}

// ============================================================
// Agent prompt loading
// Loads current prompts from agents/ and archived historical prompts from
// benchmarks/harsh-critic/prompts/ when a benchmarked agent was removed from
// the live registry.
// ============================================================

function stripFrontmatter(content: string): string {
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

function loadAgentPromptFromFile(agentName: string): string {
  const candidatePaths = [
    join(REPO_ROOT, 'agents', `${agentName}.md`),
    join(REPO_ROOT, 'benchmarks', 'harsh-critic', 'prompts', `${agentName}.md`),
  ];
  for (const agentPath of candidatePaths) {
    try {
      const content = readFileSync(agentPath, 'utf-8');
      return stripFrontmatter(content);
    } catch {
      // Try the next candidate path.
    }
  }
  console.error(`Error: Could not load agent prompt for "${agentName}" from any known prompt path`);
  process.exit(1);
  // process.exit() throws — TypeScript needs this to satisfy the return type
  return '';
}

// ============================================================
// Fixture loading
// ============================================================

interface Fixture {
  id: string;
  content: string;
  domain: string;
}

function loadFixtures(fixtureFilter: string | null): Fixture[] {
  const fixturesDir = join(BENCHMARK_DIR, 'fixtures');
  const domains = ['plans', 'code', 'analysis'];
  const fixtures: Fixture[] = [];

  for (const domain of domains) {
    const domainDir = join(fixturesDir, domain);
    if (!existsSync(domainDir)) continue;

    let files: string[];
    try {
      files = readdirSync(domainDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.md') && !file.endsWith('.ts')) continue;
      const id = file.replace(/\.(md|ts)$/, '');
      if (fixtureFilter !== null && id !== fixtureFilter) continue;

      const filePath = join(domainDir, file);
      const content = readFileSync(filePath, 'utf-8');
      fixtures.push({ id, content, domain });
    }
  }

  if (fixtures.length === 0) {
    if (fixtureFilter !== null) {
      console.error(`Error: Fixture "${fixtureFilter}" not found in fixtures/ directory`);
    } else {
      console.error('Error: No fixtures found in fixtures/ directory');
    }
    process.exit(1);
  }

  return fixtures;
}

// ============================================================
// Ground truth loading
// ============================================================

function loadGroundTruth(fixtureId: string): GroundTruth | null {
  const gtPath = join(BENCHMARK_DIR, 'ground-truth', `${fixtureId}.json`);
  if (!existsSync(gtPath)) {
    return null;
  }
  try {
    const raw = readFileSync(gtPath, 'utf-8');
    return JSON.parse(raw) as GroundTruth;
  } catch (err) {
    console.error(`Error: Failed to parse ground truth for "${fixtureId}": ${err}`);
    process.exit(1);
    // process.exit() throws — TypeScript needs this to satisfy the return type
    return null;
  }
}

// ============================================================
// Claude API call
// ============================================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callClaude(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string,
  model: string,
  maxRetries = 5,
): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text content in Claude response');
      }
      return textBlock.text;
    } catch (err: unknown) {
      const isRetryable =
        err instanceof Error &&
        (err.message.includes('529') ||
          err.message.includes('overloaded') ||
          err.message.includes('rate') ||
          err.message.includes('500'));
      if (isRetryable && attempt < maxRetries) {
        const delayMs = Math.min(1000 * 2 ** attempt, 60000);
        process.stdout.write(`\n    Retrying in ${(delayMs / 1000).toFixed(0)}s (attempt ${attempt + 1}/${maxRetries})... `);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Exhausted retries');
}

// ============================================================
// Console formatting helpers
// ============================================================

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function printSummaryTable(results: FixtureResult[]): void {
  const agentTypes: AgentType[] = ['harsh-critic', 'critic'];
  const fixtureIds = Array.from(new Set(results.map((r) => r.fixtureId))).sort();

  console.log('\n=== Benchmark Results ===\n');
  console.log(
    padEnd('Fixture', 30) +
    padEnd('Agent', 16) +
    padEnd('Composite', 12) +
    padEnd('TP Rate', 10) +
    padEnd('FN Rate', 10) +
    padEnd('Missing Cov', 12),
  );
  console.log('-'.repeat(90));

  for (const fixtureId of fixtureIds) {
    for (const agentType of agentTypes) {
      const result = results.find(
        (r) => r.fixtureId === fixtureId && r.agentType === agentType,
      );
      if (!result) continue;
      const s = result.scores;
      console.log(
        padEnd(fixtureId, 30) +
        padEnd(agentType, 16) +
        padEnd(pct(s.compositeScore), 12) +
        padEnd(pct(s.truePositiveRate), 10) +
        padEnd(pct(s.falseNegativeRate), 10) +
        padEnd(pct(s.missingCoverage), 12),
      );
    }
  }

  console.log('');
}

function printHeadToHead(
  headToHead: Array<{ fixtureId: string; winner: AgentType | 'tie'; delta: number }>,
): void {
  console.log('=== Head-to-Head ===\n');
  const wins = headToHead.filter((h) => h.winner === 'harsh-critic').length;
  const losses = headToHead.filter((h) => h.winner === 'critic').length;
  const ties = headToHead.filter((h) => h.winner === 'tie').length;
  console.log(`harsh-critic wins: ${wins}  |  critic wins: ${losses}  |  ties: ${ties}\n`);
  for (const h of headToHead) {
    const deltaSign = h.delta >= 0 ? '+' : '';
    console.log(
      `  ${padEnd(h.fixtureId, 30)} winner=${padEnd(h.winner, 14)} delta=${deltaSign}${pct(h.delta)}`,
    );
  }
  console.log('');
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs();

  // Validate API key early (unless dry run)
  if (!args.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Error: ANTHROPIC_API_KEY environment variable is not set.\n' +
      'Set it before running:\n' +
      '  ANTHROPIC_API_KEY=sk-... npx tsx benchmarks/harsh-critic/run-benchmark.ts',
    );
    process.exit(1);
  }

  // Determine which agents to run
  const agentsToRun: AgentType[] =
    args.agent === 'both' ? ['harsh-critic', 'critic'] : [args.agent];

  // Load agent prompts
  console.log('Loading agent prompts...');
  const agentPrompts: Record<AgentType, string> = {
    'harsh-critic': loadAgentPromptFromFile('harsh-critic'),
    'critic': loadAgentPromptFromFile('critic'),
  };

  // Load fixtures
  console.log('Loading fixtures...');
  const fixtures = loadFixtures(args.fixture);
  console.log(`  ${fixtures.length} fixture(s) found: ${fixtures.map((f) => f.id).join(', ')}`);

  // Load ground truth for each fixture
  console.log('Loading ground truth...');
  const groundTruthMap = new Map<string, GroundTruth | null>();
  for (const fixture of fixtures) {
    const gt = loadGroundTruth(fixture.id);
    groundTruthMap.set(fixture.id, gt);
    if (gt === null) {
      console.warn(
        `  Warning: No ground truth found for fixture "${fixture.id}" — will score with empty ground truth`,
      );
    } else {
      console.log(`  ${fixture.id}: ${gt.findings.length} ground truth finding(s)`);
    }
  }

  if (args.dryRun) {
    console.log('\nDry run complete. Pipeline validated — skipping API calls.');
    console.log(`  Agents:     ${agentsToRun.join(', ')}`);
    console.log(`  Fixtures:   ${fixtures.map((f) => f.id).join(', ')}`);
    console.log(`  Model:      ${args.model}`);
    console.log(`  Output dir: ${args.outputDir}`);
    return;
  }

  // Initialize Anthropic client
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Create output directory if needed
  if (!existsSync(args.outputDir)) {
    mkdirSync(args.outputDir, { recursive: true });
  }

  // Run benchmark
  const allResults: FixtureResult[] = [];
  const totalRuns = fixtures.length * agentsToRun.length;

  console.log(
    `\nRunning benchmark: ${totalRuns} run(s) total` +
    ` (${agentsToRun.join(', ')} x ${fixtures.length} fixture(s))...\n`,
  );

  for (const agentType of agentsToRun) {
    const systemPrompt = agentPrompts[agentType];

    for (const fixture of fixtures) {
      const label = `${agentType} on ${fixture.id}`;
      process.stdout.write(`Running ${label}... `);
      const startMs = Date.now();

      let rawOutput: string;
      try {
        rawOutput = await callClaude(
          client,
          systemPrompt,
          `Review the following work:\n\n${fixture.content}`,
          args.model,
        );
      } catch (err) {
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
        console.log(`FAILED (${elapsedS}s)`);
        console.error(`  Error calling Claude API: ${err}`);
        process.exit(1);
      }

      const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
      console.log(`done (${elapsedS}s)`);

      // Parse agent output
      const parsedOutput = parseAgentOutput(rawOutput, agentType);

      // Build ground truth — use empty placeholder if none exists
      const groundTruth: GroundTruth = groundTruthMap.get(fixture.id) ?? {
        fixtureId: fixture.id,
        fixturePath: fixture.id,
        domain: fixture.domain as GroundTruth['domain'],
        expectedVerdict: 'REJECT',
        findings: [],
        isCleanBaseline: false,
      };

      // Score and collect match details
      const scores = scoreFixture(parsedOutput, groundTruth);
      const matchResult = matchFindings(parsedOutput, groundTruth);

      const fixtureResult: FixtureResult = {
        fixtureId: fixture.id,
        domain: groundTruth.domain,
        agentType,
        parsedOutput,
        scores,
        matchedFindings: matchResult.matchedIds,
        missedFindings: matchResult.missedIds,
        spuriousFindings: matchResult.spuriousTexts,
      };

      allResults.push(fixtureResult);
    }
  }

  // Generate reports
  console.log('\nGenerating reports...');
  const jsonReport = generateJsonReport(allResults, args.model);
  const markdownReport = generateMarkdownReport(jsonReport);

  // Timestamped + "latest" output files
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const jsonPath = join(args.outputDir, `results_${timestamp}.json`);
  const mdPath = join(args.outputDir, `report_${timestamp}.md`);
  const latestJsonPath = join(args.outputDir, 'results.json');
  const latestMdPath = join(args.outputDir, 'report.md');

  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');
  writeFileSync(mdPath, markdownReport, 'utf-8');
  writeFileSync(latestJsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');
  writeFileSync(latestMdPath, markdownReport, 'utf-8');

  console.log(`  Written: ${jsonPath}`);
  console.log(`  Written: ${mdPath}`);
  console.log(`  Latest:  ${latestJsonPath}`);
  console.log(`  Latest:  ${latestMdPath}`);

  // Print summary
  printSummaryTable(allResults);

  if (agentsToRun.length === 2) {
    printHeadToHead(jsonReport.headToHead);

    const harsh = jsonReport.aggregateScores['harsh-critic'];
    const critic = jsonReport.aggregateScores['critic'];
    const delta = harsh.compositeScore - critic.compositeScore;
    const deltaSign = delta >= 0 ? '+' : '';

    console.log('=== Aggregate Scores ===\n');
    console.log(`  harsh-critic composite: ${pct(harsh.compositeScore)}`);
    console.log(`  critic composite:       ${pct(critic.compositeScore)}`);
    console.log(`  delta:                  ${deltaSign}${pct(delta)}`);
    console.log('');
  }

  console.log('Benchmark complete.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
