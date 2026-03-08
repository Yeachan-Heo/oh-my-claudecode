/**
 * Shared runner utilities for agent benchmarks.
 *
 * Provides common logic for:
 * - CLI argument parsing
 * - Fixture/ground-truth loading
 * - Anthropic API calls with retry
 * - Console formatting
 * - Report generation and file output
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

import type {
  AgentType,
  BenchmarkScores,
  FixtureResult,
  GroundTruth,
  ParsedAgentOutput,
} from './types.ts';
import { scoreFixture, matchFindings } from './scorer.ts';
import { generateComparisonReport, generateMarkdownReport } from './reporter.ts';

// ============================================================
// CLI argument parsing
// ============================================================

export interface BenchmarkCliArgs {
  /** Which agent variant(s) to run */
  agents: string[];
  /** Run a single fixture only */
  fixture: string | null;
  /** Where to write results */
  outputDir: string;
  /** Claude model to use */
  model: string;
  /** Load fixtures and ground truth but skip API calls */
  dryRun: boolean;
}

export function parseCliArgs(
  defaultAgents: string[],
  defaultOutputDir: string,
): BenchmarkCliArgs {
  const args = process.argv.slice(2);
  const result: BenchmarkCliArgs = {
    agents: defaultAgents,
    fixture: null,
    outputDir: defaultOutputDir,
    model: 'claude-opus-4-6',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--agent':
        result.agents = [args[++i]];
        break;
      case '--agents':
        result.agents = args[++i].split(',');
        break;
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
        // Ignore unknown args — the top-level runner may pass extra flags
        break;
    }
  }

  return result;
}

// ============================================================
// Fixture loading
// ============================================================

export interface Fixture {
  id: string;
  content: string;
  domain: string;
}

/**
 * Load fixtures from a benchmark directory.
 * Scans all subdirectories under fixtures/.
 */
export function loadFixtures(
  benchmarkDir: string,
  fixtureFilter: string | null,
): Fixture[] {
  const fixturesDir = join(benchmarkDir, 'fixtures');
  const fixtures: Fixture[] = [];

  if (!existsSync(fixturesDir)) {
    console.error(`Error: Fixtures directory not found: ${fixturesDir}`);
    process.exit(1);
  }

  const domains = readdirSync(fixturesDir);

  for (const domain of domains) {
    const domainDir = join(fixturesDir, domain);
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
      console.error(`Error: Fixture "${fixtureFilter}" not found in ${fixturesDir}`);
    } else {
      console.error(`Error: No fixtures found in ${fixturesDir}`);
    }
    process.exit(1);
  }

  return fixtures;
}

// ============================================================
// Ground truth loading
// ============================================================

export function loadGroundTruth(
  benchmarkDir: string,
  fixtureId: string,
): GroundTruth | null {
  const gtPath = join(benchmarkDir, 'ground-truth', `${fixtureId}.json`);
  if (!existsSync(gtPath)) {
    return null;
  }
  try {
    const raw = readFileSync(gtPath, 'utf-8');
    return JSON.parse(raw) as GroundTruth;
  } catch (err) {
    console.error(`Error: Failed to parse ground truth for "${fixtureId}": ${err}`);
    process.exit(1);
    return null;
  }
}

// ============================================================
// Agent prompt loading
// ============================================================

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Load an agent prompt from the agents/ directory or a benchmark prompts/ archive.
 */
export function loadAgentPrompt(
  agentName: string,
  benchmarkDir: string,
  repoRoot: string,
): string {
  const candidatePaths = [
    join(repoRoot, 'agents', `${agentName}.md`),
    join(benchmarkDir, 'prompts', `${agentName}.md`),
  ];
  for (const agentPath of candidatePaths) {
    try {
      const content = readFileSync(agentPath, 'utf-8');
      return stripFrontmatter(content);
    } catch {
      // Try the next candidate path
    }
  }
  console.error(`Error: Could not load agent prompt for "${agentName}" from any known path`);
  process.exit(1);
  return '';
}

// ============================================================
// Claude API call
// ============================================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApiCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callClaude(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string,
  model: string,
  maxRetries = 5,
): Promise<ApiCallResult> {
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
      return {
        text: textBlock.text,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
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

/**
 * Create an Anthropic client, respecting environment variables.
 */
export function createClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = process.env.ANTHROPIC_BASE_URL;

  if (!apiKey) {
    console.error(
      'Error: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN environment variable is not set.\n' +
      'Set it before running the benchmark.',
    );
    process.exit(1);
  }

  const opts: Record<string, unknown> = { apiKey };
  if (baseURL) {
    opts.baseURL = baseURL;
  }

  return new Anthropic(opts as ConstructorParameters<typeof Anthropic>[0]);
}

// ============================================================
// Console formatting helpers
// ============================================================

export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

export function printSummaryTable(results: FixtureResult[], agentTypes: string[]): void {
  const fixtureIds = Array.from(new Set(results.map((r) => r.fixtureId))).sort();

  console.log('\n=== Benchmark Results ===\n');
  console.log(
    padEnd('Fixture', 30) +
    padEnd('Agent', 20) +
    padEnd('Composite', 12) +
    padEnd('TP Rate', 10) +
    padEnd('FN Rate', 10) +
    padEnd('Latency', 10),
  );
  console.log('-'.repeat(92));

  for (const fixtureId of fixtureIds) {
    for (const agentType of agentTypes) {
      const result = results.find(
        (r) => r.fixtureId === fixtureId && r.agentType === agentType,
      );
      if (!result) continue;
      const s = result.scores;
      const latency = result.latencyMs ? `${(result.latencyMs / 1000).toFixed(1)}s` : '-';
      console.log(
        padEnd(fixtureId, 30) +
        padEnd(agentType, 20) +
        padEnd(pct(s.compositeScore), 12) +
        padEnd(pct(s.truePositiveRate), 10) +
        padEnd(pct(s.falseNegativeRate), 10) +
        padEnd(latency, 10),
      );
    }
  }

  console.log('');
}

// ============================================================
// Report file output
// ============================================================

export function writeReports(
  outputDir: string,
  results: FixtureResult[],
  agentA: string,
  agentB: string,
  model: string,
): void {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const jsonReport = generateComparisonReport(results, agentA, agentB, model);
  const markdownReport = generateMarkdownReport(jsonReport, agentA, agentB);

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  const jsonPath = join(outputDir, `results_${timestamp}.json`);
  const mdPath = join(outputDir, `report_${timestamp}.md`);
  const latestJsonPath = join(outputDir, 'results.json');
  const latestMdPath = join(outputDir, 'report.md');

  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');
  writeFileSync(mdPath, markdownReport, 'utf-8');
  writeFileSync(latestJsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');
  writeFileSync(latestMdPath, markdownReport, 'utf-8');

  console.log(`  Written: ${jsonPath}`);
  console.log(`  Written: ${mdPath}`);
  console.log(`  Latest:  ${latestJsonPath}`);
  console.log(`  Latest:  ${latestMdPath}`);
}

// ============================================================
// Generic benchmark runner
// ============================================================

export interface AgentConfig {
  /** Agent type identifier for results labeling */
  agentType: string;
  /** System prompt to use */
  systemPrompt: string;
  /** User message template — receives fixture content as input */
  userMessageTemplate: (fixtureContent: string) => string;
}

/**
 * Run a full benchmark: iterate agents x fixtures, parse, score, report.
 */
export async function runBenchmark(opts: {
  benchmarkDir: string;
  agents: AgentConfig[];
  fixtures: Fixture[];
  groundTruthDir: string;
  parseFn: (rawOutput: string, agentType: string) => ParsedAgentOutput;
  cliArgs: BenchmarkCliArgs;
}): Promise<FixtureResult[]> {
  const { agents, fixtures, parseFn, cliArgs } = opts;

  if (cliArgs.dryRun) {
    console.log('\nDry run complete. Pipeline validated — skipping API calls.');
    console.log(`  Agents:     ${agents.map((a) => a.agentType).join(', ')}`);
    console.log(`  Fixtures:   ${fixtures.map((f) => f.id).join(', ')}`);
    console.log(`  Model:      ${cliArgs.model}`);
    console.log(`  Output dir: ${cliArgs.outputDir}`);
    return [];
  }

  const client = createClient();
  const allResults: FixtureResult[] = [];
  const totalRuns = fixtures.length * agents.length;

  console.log(
    `\nRunning benchmark: ${totalRuns} run(s) total` +
    ` (${agents.map((a) => a.agentType).join(', ')} x ${fixtures.length} fixture(s))...\n`,
  );

  for (const agent of agents) {
    for (const fixture of fixtures) {
      const label = `${agent.agentType} on ${fixture.id}`;
      process.stdout.write(`Running ${label}... `);
      const startMs = Date.now();

      let apiResult: ApiCallResult;
      try {
        apiResult = await callClaude(
          client,
          agent.systemPrompt,
          agent.userMessageTemplate(fixture.content),
          cliArgs.model,
        );
      } catch (err) {
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
        console.log(`FAILED (${elapsedS}s)`);
        console.error(`  Error calling Claude API: ${err}`);
        process.exit(1);
      }

      const elapsedMs = Date.now() - startMs;
      console.log(`done (${(elapsedMs / 1000).toFixed(1)}s)`);

      // Parse agent output
      const parsedOutput = parseFn(apiResult.text, agent.agentType);

      // Load ground truth
      const groundTruth: GroundTruth = loadGroundTruth(opts.benchmarkDir, fixture.id) ?? {
        fixtureId: fixture.id,
        fixturePath: fixture.id,
        domain: fixture.domain as GroundTruth['domain'],
        expectedVerdict: 'REJECT',
        findings: [],
        isCleanBaseline: false,
      };

      // Score
      const scores = scoreFixture(parsedOutput, groundTruth);
      const matchResult = matchFindings(parsedOutput, groundTruth);

      const fixtureResult: FixtureResult = {
        fixtureId: fixture.id,
        domain: groundTruth.domain,
        agentType: agent.agentType,
        parsedOutput,
        scores,
        matchedFindings: matchResult.matchedIds,
        missedFindings: matchResult.missedIds,
        spuriousFindings: matchResult.spuriousTexts,
        latencyMs: elapsedMs,
        inputTokens: apiResult.inputTokens,
        outputTokens: apiResult.outputTokens,
      };

      allResults.push(fixtureResult);
    }
  }

  return allResults;
}
