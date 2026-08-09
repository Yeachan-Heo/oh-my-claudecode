import Anthropic from "@anthropic-ai/sdk";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { performance } from "perf_hooks";

import type {
  BenchmarkScores,
  Domain,
  FailedFixtureResult,
  FailureReason,
  FixtureResult,
  GroundTruth,
  ParsedAgentOutput,
} from "./types.ts";
import {
  matchFindingsShared,
  scoreFixtureShared,
  validateSharedGroundTruth,
} from "./scorer.ts";
import {
  generateComparisonReport,
  generateMarkdownReport,
} from "./reporter.ts";

export interface BenchmarkCliArgs {
  agents: string[];
  fixture: string | null;
  outputDir: string;
  model: string;
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
    model: "claude-opus-4-6",
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--agent":
        result.agents = [args[++i]];
        break;
      case "--agents":
        result.agents = args[++i].split(",");
        break;
      case "--fixture":
        result.fixture = args[++i];
        break;
      case "--output-dir":
        result.outputDir = args[++i];
        break;
      case "--model":
        result.model = args[++i];
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      default:
        // Top-level runners intentionally pass through unrelated flags.
        break;
    }
  }
  return result;
}

const FIXTURE_DIRECTORY_TO_DOMAIN = new Map<string, Domain>([
  ["code", "code"],
  ["analysis", "analysis"],
  ["plans", "plan"],
  ["bugs", "bug"],
  ["tasks", "task"],
]);

export class InvalidFixtureDirectoryError extends Error {
  constructor(directory: string) {
    super(`Unsupported fixture directory: ${directory}`);
    this.name = "InvalidFixtureDirectoryError";
  }
}

export function fixtureDomainFromDirectory(directory: string): Domain {
  const domain = FIXTURE_DIRECTORY_TO_DOMAIN.get(directory);
  if (!domain) throw new InvalidFixtureDirectoryError(directory);
  return domain;
}

export interface Fixture {
  id: string;
  content: string;
  domain: Domain;
}

export function loadFixtures(
  benchmarkDir: string,
  fixtureFilter: string | null,
): Fixture[] {
  const fixturesDir = join(benchmarkDir, "fixtures");
  const fixtures: Fixture[] = [];
  if (!existsSync(fixturesDir))
    throw new Error(`Fixtures directory not found: ${fixturesDir}`);

  for (const directory of readdirSync(fixturesDir)) {
    const domainDir = join(fixturesDir, directory);
    if (!statSync(domainDir).isDirectory()) continue;
    const files = readdirSync(domainDir);
    const domain = fixtureDomainFromDirectory(directory);
    for (const file of files) {
      if (!file.endsWith(".md") && !file.endsWith(".ts")) continue;
      const id = file.replace(/\.(md|ts)$/, "");
      if (fixtureFilter !== null && id !== fixtureFilter) continue;
      fixtures.push({
        id,
        content: readFileSync(join(domainDir, file), "utf-8"),
        domain,
      });
    }
  }

  if (fixtures.length === 0) {
    throw new Error(
      fixtureFilter
        ? `Fixture "${fixtureFilter}" not found`
        : "No fixtures found",
    );
  }
  return fixtures;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function readOptionalText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export function loadGroundTruth(
  groundTruthDir: string,
  fixture: Pick<Fixture, "id" | "domain">,
): GroundTruth | null {
  if (!statSync(groundTruthDir).isDirectory()) {
    throw new Error(`Ground-truth path is not a directory: ${groundTruthDir}`);
  }
  const gtPath = join(groundTruthDir, `${fixture.id}.json`);
  const raw = readOptionalText(gtPath);
  if (raw === null) return null;
  const parsed = validateSharedGroundTruth(JSON.parse(raw));
  if (parsed.fixtureId !== fixture.id || parsed.domain !== fixture.domain) {
    throw new Error(
      `Ground truth identity mismatch: expected ${fixture.domain}:${fixture.id}, got ${parsed.domain}:${parsed.fixtureId}`,
    );
  }
  return parsed;
}

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

export function loadAgentPrompt(
  agentName: string,
  benchmarkDir: string,
  repoRoot: string,
): string {
  const primaryPath = join(repoRoot, "agents", `${agentName}.md`);
  const primary = readOptionalText(primaryPath);
  if (primary !== null) return stripFrontmatter(primary);

  const archivePath = join(benchmarkDir, "prompts", `${agentName}.md`);
  const archive = readOptionalText(archivePath);
  if (archive !== null) return stripFrontmatter(archive);

  throw new Error(`Could not load agent prompt for "${agentName}"`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApiCallResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
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
        messages: [{ role: "user", content: userMessage }],
      });
      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text")
        throw new Error("No text content in Claude response");
      return {
        text: textBlock.text,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      };
    } catch (error: unknown) {
      const retryable =
        error instanceof Error &&
        ["529", "overloaded", "rate", "500"].some((token) =>
          error.message.includes(token),
        );
      if (retryable && attempt < maxRetries) {
        const delayMs = Math.min(1000 * 2 ** attempt, 60000);
        process.stdout.write(
          `\n    Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})... `,
        );
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Exhausted retries");
}

export function createClient(): Anthropic {
  const apiKey =
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey)
    throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is not set");
  const options: ConstructorParameters<typeof Anthropic>[0] = { apiKey };
  if (process.env.ANTHROPIC_BASE_URL)
    options.baseURL = process.env.ANTHROPIC_BASE_URL;
  return new Anthropic(options);
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function padEnd(value: string, length: number): string {
  return value.length >= length
    ? value
    : value + " ".repeat(length - value.length);
}

export function printSummaryTable(
  results: FixtureResult[],
  agentTypes: string[],
): void {
  const fixtureIdentities = Array.from(
    new Map(
      results.map((result) => [
        `${result.domain}:${result.fixtureId}`,
        { domain: result.domain, fixtureId: result.fixtureId },
      ]),
    ).values(),
  ).sort((left, right) =>
    `${left.domain}:${left.fixtureId}`.localeCompare(
      `${right.domain}:${right.fixtureId}`,
    ),
  );
  console.log("\n=== Benchmark Results ===\n");
  console.log(
    padEnd("Fixture", 28) +
      padEnd("Agent", 18) +
      padEnd("Status", 10) +
      padEnd("Quality", 10) +
      padEnd("Tokens", 10) +
      padEnd("API", 10) +
      padEnd("Harness", 10),
  );
  console.log("-".repeat(96));

  for (const { domain, fixtureId } of fixtureIdentities) {
    for (const agentType of agentTypes) {
      const result = results.find(
        (candidate) =>
          candidate.domain === domain &&
          candidate.fixtureId === fixtureId &&
          candidate.agentType === agentType,
      );
      if (!result) continue;
      console.log(
        padEnd(`${result.domain}:${fixtureId}`, 28) +
          padEnd(agentType, 18) +
          padEnd(result.completion, 10) +
          padEnd(
            result.completion === "completed"
              ? pct(result.scores.compositeScore)
              : "-",
            10,
          ) +
          padEnd(result.totalTokens?.toString() ?? "-", 10) +
          padEnd(
            result.latencyMs === undefined
              ? "-"
              : `${result.latencyMs.toFixed(1)}ms`,
            10,
          ) +
          padEnd(
            result.harnessOverheadMs === undefined
              ? "-"
              : `${result.harnessOverheadMs.toFixed(1)}ms`,
            10,
          ),
      );
    }
  }
  console.log("");
}

export function writeReports(
  outputDir: string,
  results: FixtureResult[],
  agentA: string,
  agentB: string,
  model: string,
): void {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const jsonReport = generateComparisonReport(results, agentA, agentB, model);
  const markdownReport = generateMarkdownReport(jsonReport, agentA, agentB);
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  for (const [path, content] of [
    [
      join(outputDir, `results_${timestamp}.json`),
      JSON.stringify(jsonReport, null, 2),
    ],
    [join(outputDir, `report_${timestamp}.md`), markdownReport],
    [join(outputDir, "results.json"), JSON.stringify(jsonReport, null, 2)],
    [join(outputDir, "report.md"), markdownReport],
  ] as const) {
    writeFileSync(path, content, "utf-8");
  }
}

export interface AgentConfig {
  agentType: string;
  systemPrompt: string;
  userMessageTemplate: (fixtureContent: string) => string;
}

export interface Clock {
  now(): number;
}

interface RunBenchmarkOptions {
  benchmarkDir: string;
  agents: AgentConfig[];
  fixtures: Fixture[];
  groundTruthDir: string;
  parseFn: (rawOutput: string, agentType: string) => ParsedAgentOutput;
  cliArgs: BenchmarkCliArgs;
  clock?: Clock;
  callApi?: (
    systemPrompt: string,
    userMessage: string,
    model: string,
  ) => Promise<ApiCallResult>;
  scoreFn?: typeof scoreFixtureShared;
  matchFn?: typeof matchFindingsShared;
}

function totalTokens(result: ApiCallResult | undefined): number | undefined {
  return result?.inputTokens !== undefined && result.outputTokens !== undefined
    ? result.inputTokens + result.outputTokens
    : undefined;
}

function failedResult(input: {
  fixture: Fixture;
  agentType: string;
  reason: FailureReason;
  apiResult?: ApiCallResult;
  latencyMs?: number;
  harnessOverheadMs?: number;
  groundTruthMissing?: boolean;
}): FailedFixtureResult {
  return {
    fixtureId: input.fixture.id,
    domain: input.fixture.domain,
    agentType: input.agentType,
    completion: "failed",
    failureReason: input.reason,
    groundTruthMissing: input.groundTruthMissing,
    matchedFindings: [],
    missedFindings: [],
    spuriousFindings: [],
    latencyMs: input.latencyMs,
    harnessOverheadMs: input.harnessOverheadMs,
    inputTokens: input.apiResult?.inputTokens,
    outputTokens: input.apiResult?.outputTokens,
    totalTokens: totalTokens(input.apiResult),
  };
}

export function countFailures(results: FixtureResult[]): number {
  return results.filter((result) => result.completion === "failed").length;
}

export function exitCodeForResults(results: FixtureResult[]): 0 | 1 {
  return countFailures(results) > 0 ? 1 : 0;
}

export async function runBenchmark(
  options: RunBenchmarkOptions,
): Promise<FixtureResult[]> {
  const { agents, fixtures, parseFn, cliArgs } = options;
  if (cliArgs.dryRun) {
    console.log("\nDry run complete. Pipeline validated — skipping API calls.");
    return [];
  }

  const clock = options.clock ?? { now: () => performance.now() };
  const invoke =
    options.callApi ??
    (() => {
      const client = createClient();
      return (systemPrompt: string, userMessage: string, model: string) =>
        callClaude(client, systemPrompt, userMessage, model);
    })();
  const scoreFn = options.scoreFn ?? scoreFixtureShared;
  const matchFn = options.matchFn ?? matchFindingsShared;
  const allResults: FixtureResult[] = [];

  for (const agent of agents) {
    for (const fixture of fixtures) {
      process.stdout.write(`Running ${agent.agentType} on ${fixture.id}... `);
      let userMessage: string;
      try {
        userMessage = agent.userMessageTemplate(fixture.content);
      } catch (error) {
        console.log("FAILED (prompt)");
        console.error(error);
        allResults.push(
          failedResult({
            fixture,
            agentType: agent.agentType,
            reason: "prompt",
          }),
        );
        continue;
      }

      const apiStart = clock.now();
      let apiResult: ApiCallResult;
      try {
        apiResult = await invoke(
          agent.systemPrompt,
          userMessage,
          cliArgs.model,
        );
      } catch (error) {
        const latencyMs = clock.now() - apiStart;
        console.log(`FAILED (${latencyMs.toFixed(1)}ms)`);
        console.error(error);
        allResults.push(
          failedResult({
            fixture,
            agentType: agent.agentType,
            reason: "api",
            latencyMs,
          }),
        );
        continue;
      }
      const latencyMs = clock.now() - apiStart;
      const overheadStart = clock.now();

      let parsedOutput: ParsedAgentOutput;
      try {
        parsedOutput = parseFn(apiResult.text, agent.agentType);
      } catch (error) {
        console.log("FAILED (parse)");
        console.error(error);
        allResults.push(
          failedResult({
            fixture,
            agentType: agent.agentType,
            reason: "parse",
            apiResult,
            latencyMs,
            harnessOverheadMs: clock.now() - overheadStart,
          }),
        );
        continue;
      }

      const groundTruth = loadGroundTruth(options.groundTruthDir, fixture);
      if (!groundTruth) {
        console.log("FAILED (missing ground truth)");
        allResults.push(
          failedResult({
            fixture,
            agentType: agent.agentType,
            reason: "missing-ground-truth",
            apiResult,
            latencyMs,
            harnessOverheadMs: clock.now() - overheadStart,
            groundTruthMissing: true,
          }),
        );
        continue;
      }

      let scores: BenchmarkScores;
      try {
        scores = scoreFn(parsedOutput, groundTruth);
      } catch (error) {
        console.log("FAILED (score)");
        console.error(error);
        allResults.push(
          failedResult({
            fixture,
            agentType: agent.agentType,
            reason: "score",
            apiResult,
            latencyMs,
            harnessOverheadMs: clock.now() - overheadStart,
          }),
        );
        continue;
      }

      let matchResult: ReturnType<typeof matchFindingsShared>;
      try {
        matchResult = matchFn(parsedOutput, groundTruth);
      } catch (error) {
        console.log("FAILED (match)");
        console.error(error);
        allResults.push(
          failedResult({
            fixture,
            agentType: agent.agentType,
            reason: "match",
            apiResult,
            latencyMs,
            harnessOverheadMs: clock.now() - overheadStart,
          }),
        );
        continue;
      }

      allResults.push({
        fixtureId: fixture.id,
        domain: fixture.domain,
        agentType: agent.agentType,
        completion: "completed",
        parsedOutput,
        scores,
        matchedFindings: matchResult.matchedIds,
        missedFindings: matchResult.missedIds,
        spuriousFindings: matchResult.spuriousTexts,
        latencyMs,
        harnessOverheadMs: clock.now() - overheadStart,
        inputTokens: apiResult.inputTokens,
        outputTokens: apiResult.outputTokens,
        totalTokens: totalTokens(apiResult),
      });
      console.log(`done (${latencyMs.toFixed(1)}ms)`);
    }
  }
  return allResults;
}
