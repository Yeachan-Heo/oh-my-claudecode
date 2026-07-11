import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const PERF_GLOB = "tests/perf/**";
const QUOTED_PERF_GLOB = `"${PERF_GLOB}"`;
const PERF_TARGET = "tests/perf/subagent-lock.bench.ts";
const PERF_SCRIPT = "test:perf:subagent-lock";
const FUNCTIONAL_SCRIPTS = {
  test: ["vitest"],
  "test:run": ["vitest", "run"],
  "test:ui": ["vitest", "--ui"],
  "test:coverage": ["vitest", "run", "--coverage"],
} as const;

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function tokens(command: string): string[] {
  return command.trim().split(/\s+/);
}

function extractJob(workflow: string, jobName: string): string {
  const jobs = workflow.match(/^jobs:\s*$/m);
  expect(jobs, "workflow must define jobs").toBeTruthy();

  const start = workflow.indexOf(`  ${jobName}:`, jobs?.index);
  expect(
    start,
    `workflow must define the ${jobName} job`,
  ).toBeGreaterThanOrEqual(0);

  const remainder = workflow.slice(start);
  const nextJob = remainder.slice(1).search(/^  [\w-]+:\s*$/m);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob + 1);
}

type WorkflowStep = { raw: string; run?: string };

function extractSteps(job: string): WorkflowStep[] {
  const stepStarts = [...job.matchAll(/^      - (?=name:|uses:|run:)/gm)].map(
    (match) => match.index!,
  );
  return stepStarts.map((start, index) => {
    const raw = job.slice(start, stepStarts[index + 1]);
    const inlineRun = raw
      .match(/^        run:\s*([^\n|>][^\n]*)$/m)?.[1]
      ?.trim();
    const blockRun = raw.match(
      /^        run:\s*[>|][-+]?\s*\n((?:          .*\n?)*)/m,
    )?.[1];
    const run = inlineRun ?? blockRun?.replace(/^          /gm, "").trim();
    return { raw, run };
  });
}

function assertWorkflowCommands(
  workflow: string,
  jobName: string,
  release = false,
): void {
  const job = extractJob(workflow, jobName);
  expect(job).toMatch(/^    runs-on: ubuntu-latest$/m);

  const steps = extractSteps(job);
  const functional = steps.filter((step) =>
    step.run?.includes("npm test -- --run"),
  );
  const perf = steps.filter((step) =>
    step.run?.includes(`npm run ${PERF_SCRIPT}`),
  );

  expect(
    functional,
    `${jobName} must have one functional package step`,
  ).toHaveLength(1);
  expect(perf, `${jobName} must have one perf package step`).toHaveLength(1);
  expect(functional[0].run).toBe("npm test -- --run");
  expect(perf[0].run).toBe(`npm run ${PERF_SCRIPT}`);
  expect(functional[0]).not.toBe(perf[0]);
  expect(steps.indexOf(functional[0])).toBeLessThan(steps.indexOf(perf[0]));

  for (const step of [...functional, ...perf]) {
    expect(step.raw, `${jobName} test steps must block failures`).not.toMatch(
      /^        continue-on-error:\s*true\s*$/m,
    );
  }

  const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
  expect(
    commands.join("\n"),
    `${jobName} must not recombine the test commands`,
  ).not.toMatch(/npm test\s+--\s+--run\s*[;&|]/);
  expect(
    commands.join("\n"),
    `${jobName} must not invoke the benchmark directly`,
  ).not.toContain(PERF_TARGET);
  expect(
    commands.join("\n"),
    `${jobName} must not set raw serialization flags`,
  ).not.toMatch(/--(?:fileParallelism|maxWorkers)/);

  if (release) {
    const sideEffect = steps.findIndex(
      (step) =>
        step.raw.includes("npm publish") ||
        step.raw.includes("action-gh-release"),
    );
    expect(
      sideEffect,
      "release must retain a publish or release side effect",
    ).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(perf[0])).toBeLessThan(sideEffect);
  }
}

describe("subagent-lock test contract", () => {
  it("keeps all functional Vitest scripts explicitly out of perf", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };

    for (const [name, expectedPrefix] of Object.entries(FUNCTIONAL_SCRIPTS)) {
      const command = pkg.scripts[name];
      expect(command, `missing ${name}`).toBeTypeOf("string");
      const commandTokens = tokens(command);
      expect(commandTokens.slice(0, expectedPrefix.length)).toEqual(
        expectedPrefix,
      );
      const excludeIndexes = commandTokens.flatMap((token, index) =>
        token === "--exclude" ? [index] : [],
      );
      expect(
        excludeIndexes,
        `${name} must have exactly one perf exclusion`,
      ).toHaveLength(1);
      expect(commandTokens[excludeIndexes[0] + 1]).toBe(QUOTED_PERF_GLOB);
      expect(
        commandTokens.filter((token) => token.includes(PERF_GLOB)),
      ).toEqual([QUOTED_PERF_GLOB]);
      expect(command).not.toMatch(
        new RegExp(`(?:${PERF_TARGET}|${PERF_SCRIPT}|--ci|threshold)`, "i"),
      );
    }

    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name !== PERF_SCRIPT && /(?:^|\s)vitest(?:\s|$)/.test(command)) {
        expect(
          Object.keys(FUNCTIONAL_SCRIPTS),
          `unclassified Vitest script: ${name}`,
        ).toContain(name);
      }
    }
  });

  it("keeps the subagent-lock benchmark isolated and serialized", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const command = pkg.scripts[PERF_SCRIPT];
    expect(tokens(command)).toEqual([
      "vitest",
      "run",
      PERF_TARGET,
      "--fileParallelism=false",
      "--maxWorkers=1",
    ]);
    expect(command).not.toMatch(/(?:--ci|threshold)/i);
    expect(command).not.toContain("--exclude");
  });

  it("keeps CI and release as ordered, blocking package-level functional and perf gates", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const release = readRepoFile(".github/workflows/release.yml");

    assertWorkflowCommands(ci, "test");
    assertWorkflowCommands(release, "release", true);
    expect(extractJob(ci, "build")).toMatch(
      /^    needs: \[[^\]]*\btest\b[^\]]*\]$/m,
    );
  });
});
